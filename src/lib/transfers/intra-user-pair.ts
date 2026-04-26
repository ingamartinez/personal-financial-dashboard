// #518 (Epic ARQ Phase 4): intra-user transfer pairing.
//
// Pairs a newly-inserted transaction against an existing transaction that
// represents the opposite leg of a self-transfer. Supports:
//
//   1. Same-currency: exact amount match, opposite sign, same currency,
//      different account, within the time window.
//
//   2. Cross-currency (ARQ ↔ Bancolombia via PEXTO): ARQ transfer_sent has
//      a COP amount in metadata.fx.copAmountCents; Bancolombia transfer_received
//      arrived with a counterparty name matching a row in `fiat_partners`.
//      The pairer reconciles when copAmounts are within ±0.5% tolerance.
//
// Idempotent: if the incoming tx already has a transferGroupId, the function
// is a no-op. When the partner tx is found, BOTH legs are updated atomically.
//
// Late-arrival: if only one leg is present (partner arrives later), the function
// returns { groupId: null, pairedTxId: null }. When the second leg is ingested,
// it finds the orphaned first leg and pairs them.
//
// Salary block: if the found partner has a counterparty with is_salary=true,
// the pair is rejected — salary is real income, not a self-transfer.
//
// Tenant safety: ALL queries scope on user_id. Memory: per-user-table-join-tenant-safety.

import { randomUUID } from "node:crypto";
import { and, eq, gte, lte, isNull, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { db as defaultDb } from "@/lib/db";
import { transactions, counterparties, fiatPartners, userAliases, users } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "transfers/intra-user-pair" });

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PairDeps = {
  database?: DB;
};

/** Minimal shape of the newly-inserted tx needed for pairing. */
export type IncomingTx = {
  id: number;
  userId: number;
  accountId: number;
  channel: string;
  amountCents: bigint;
  currency: string;
  occurredAt: Date;
  /** FK to counterparties.id, if the parser resolved one. Used for salary block. */
  counterpartyId?: number | null;
  /** Raw counterparty string as written by the parser (e.g. "PEXTO COLOMBIA"). */
  counterparty: string | null;
  /** transactions.raw_data JSON — used to extract arq metadata. */
  rawData: Record<string, unknown> | null;
};

export type PairResult = {
  groupId: string | null;
  pairedTxId: number | null;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** ±10 min window for real-time sources (SMS, email). */
const REALTIME_WINDOW_MS = 10 * 60 * 1000;

/** ±24 h window for batch/statement sources. */
const BATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

// Tolerance for COP amount comparison in cross-currency case is 0.5% (computed
// in computeAbsTolerance as amount * 5 / 1000 using integer arithmetic).

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Attempt to pair `newTx` with an existing orphaned counterpart transaction.
 *
 * Must be called AFTER the tx is already persisted. Returns the group UUID
 * if a pair was found and committed, otherwise `{ groupId: null, pairedTxId: null }`.
 *
 * The caller does NOT need to handle the return value for correctness — it is
 * provided for logging / telemetry.
 */
export async function pairIntraUserTransfer(
  deps: PairDeps,
  newTx: IncomingTx,
): Promise<PairResult> {
  const dbc = deps.database ?? defaultDb;

  // Guard: already grouped (idempotency).
  const existing = await dbc
    .select({ transferGroupId: transactions.transferGroupId })
    .from(transactions)
    .where(and(eq(transactions.id, newTx.id), eq(transactions.userId, newTx.userId)));

  if (existing.length > 0 && existing[0].transferGroupId !== null) {
    log.debug(
      { txId: newTx.id, userId: newTx.userId, event: "pair_skip_already_grouped" },
      "tx already has transferGroupId; skipping",
    );
    return { groupId: null, pairedTxId: null };
  }

  // Determine whether this tx is a known ARQ→Bancolombia cross-currency leg.
  const arqMeta = extractArqMeta(newTx.rawData);
  const isCrossCurrencyArq = arqMeta !== null && arqMeta.copAmountCents !== null;
  const isBancolombiaFromPexto = await checkIsBancolombiaFromPexto(dbc, newTx);

  if (isCrossCurrencyArq || isBancolombiaFromPexto) {
    return pairCrossCurrency(dbc, newTx, arqMeta, isBancolombiaFromPexto);
  }

  return pairSameCurrency(dbc, newTx);
}

// ---------------------------------------------------------------------------
// Same-currency pairing
// ---------------------------------------------------------------------------

async function pairSameCurrency(dbc: DB, newTx: IncomingTx): Promise<PairResult> {
  // Use batch window (±24h) as a conservative default. Same-currency txs from
  // SMS are rare and real-time, but the batch window is safe and symmetrical.
  const windowMs = BATCH_WINDOW_MS;
  const windowStart = new Date(newTx.occurredAt.getTime() - windowMs);
  const windowEnd = new Date(newTx.occurredAt.getTime() + windowMs);

  // Opposite-sign counterpart: if this tx is negative (debit), look for positive;
  // if positive (credit), look for negative.
  const targetAmount = -newTx.amountCents;

  // Look for unpaired tx with exact opposite amount, same currency, different account.
  const candidates = await dbc
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountCents: transactions.amountCents,
      occurredAt: transactions.occurredAt,
      counterpartyId: transactions.counterpartyId,
    })
    .from(transactions)
    .where(
      and(
        // Tenant safety: always scope by user_id — memory per-user-table-join-tenant-safety.
        eq(transactions.userId, newTx.userId),
        // Must be a different account (same account would be internal double-entry, not a transfer).
        sql`${transactions.accountId} != ${newTx.accountId}`,
        // Exact opposite amount.
        eq(transactions.amountCents, targetAmount),
        // Same currency — do not mix COP and USD.
        eq(transactions.currency, newTx.currency as "COP" | "USD"),
        // Only live (non-deleted) rows.
        isNull(transactions.deletedAt),
        // Not already grouped.
        isNull(transactions.transferGroupId),
        // Time window.
        gte(transactions.occurredAt, windowStart),
        lte(transactions.occurredAt, windowEnd),
      ),
    )
    .limit(5); // unlikely to have >1 candidate; take the best if multiples

  if (candidates.length === 0) {
    log.debug(
      {
        txId: newTx.id,
        userId: newTx.userId,
        currency: newTx.currency,
        event: "pair_no_candidate_same_currency",
      },
      "no same-currency partner found; tx stays orphaned",
    );
    return { groupId: null, pairedTxId: null };
  }

  // If multiple candidates, prefer the closest in time.
  const partner = pickClosest(candidates, newTx.occurredAt);

  // Salary block: if partner's counterparty has is_salary=true, reject.
  if (await isSalaryCounterparty(dbc, newTx.userId, partner.counterpartyId)) {
    log.info(
      {
        txId: newTx.id,
        partnerTxId: partner.id,
        userId: newTx.userId,
        event: "pair_blocked_salary",
      },
      "partner counterparty is_salary=true; skipping pairing",
    );
    return { groupId: null, pairedTxId: null };
  }

  return applyGroupId(dbc, newTx.userId, newTx.id, partner.id);
}

// ---------------------------------------------------------------------------
// Cross-currency pairing (ARQ ↔ Bancolombia via PEXTO)
// ---------------------------------------------------------------------------

async function pairCrossCurrency(
  dbc: DB,
  newTx: IncomingTx,
  arqMeta: ArqMeta | null,
  isBancolombiaFromPexto: boolean,
): Promise<PairResult> {
  const windowStart = new Date(newTx.occurredAt.getTime() - BATCH_WINDOW_MS);
  const windowEnd = new Date(newTx.occurredAt.getTime() + BATCH_WINDOW_MS);

  if (isBancolombiaFromPexto) {
    // This is the Bancolombia COP credit. Find the ARQ USD debit that matches.
    return pairBancolombiaLegToArq(dbc, newTx, windowStart, windowEnd);
  }

  // This is the ARQ USD debit with COP amount metadata. Find the Bancolombia credit.
  if (!arqMeta || arqMeta.copAmountCents === null) {
    return { groupId: null, pairedTxId: null };
  }

  // TypeScript narrowing: both checks above confirm non-null values.
  return pairArqLegToBancolombia(
    dbc,
    newTx,
    { recipientName: arqMeta.recipientName, copAmountCents: arqMeta.copAmountCents },
    windowStart,
    windowEnd,
  );
}

async function pairArqLegToBancolombia(
  dbc: DB,
  newTx: IncomingTx,
  arqMeta: { recipientName: string | null; copAmountCents: bigint },
  windowStart: Date,
  windowEnd: Date,
): Promise<PairResult> {
  // Find active fiat partner names so we can match the Bancolombia counterparty.
  const activePartners = await fetchArqFiatPartners(dbc);
  if (activePartners.length === 0) {
    return { groupId: null, pairedTxId: null };
  }

  // Verify recipient matches the user (or an alias). Prevents pairing a legitimate
  // payment to a third party that happens to transit via PEXTO.
  if (arqMeta.recipientName !== null) {
    const recipientIsUser = await checkRecipientIsUser(dbc, newTx.userId, arqMeta.recipientName);
    if (!recipientIsUser) {
      log.info(
        { txId: newTx.id, userId: newTx.userId, event: "pair_recipient_not_self" },
        "ARQ recipient_name does not match user or aliases; not a self-transfer",
      );
      return { groupId: null, pairedTxId: null };
    }
  }

  const copTarget = arqMeta.copAmountCents;
  const tolerance = computeAbsTolerance(copTarget);

  // Look for Bancolombia COP credit from a fiat partner in the window.
  const candidates = await dbc
    .select({
      id: transactions.id,
      amountCents: transactions.amountCents,
      occurredAt: transactions.occurredAt,
      counterpartyId: transactions.counterpartyId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, newTx.userId),
        // Opposite leg: positive (credit).
        sql`${transactions.amountCents} > 0`,
        // COP currency.
        eq(transactions.currency, "COP"),
        // Amount within tolerance.
        gte(transactions.amountCents, copTarget - tolerance),
        lte(transactions.amountCents, copTarget + tolerance),
        // Not already paired.
        isNull(transactions.transferGroupId),
        isNull(transactions.deletedAt),
        gte(transactions.occurredAt, windowStart),
        lte(transactions.occurredAt, windowEnd),
        // counterparty text matches one of the fiat partners (ILIKE).
        buildPartnerFilter(activePartners),
      ),
    )
    .limit(5);

  if (candidates.length === 0) {
    log.debug(
      {
        txId: newTx.id,
        userId: newTx.userId,
        copAmountCents: copTarget.toString(),
        event: "pair_no_bancolombia_leg",
      },
      "no Bancolombia PEXTO credit found for ARQ debit",
    );
    return { groupId: null, pairedTxId: null };
  }

  // Salary block on partner.
  const partner = pickClosest(candidates, newTx.occurredAt);
  if (await isSalaryCounterparty(dbc, newTx.userId, partner.counterpartyId)) {
    log.info(
      {
        txId: newTx.id,
        partnerTxId: partner.id,
        userId: newTx.userId,
        event: "pair_blocked_salary",
      },
      "Bancolombia partner counterparty is_salary=true; skipping cross-currency pairing",
    );
    return { groupId: null, pairedTxId: null };
  }

  return applyGroupId(dbc, newTx.userId, newTx.id, partner.id);
}

async function pairBancolombiaLegToArq(
  dbc: DB,
  newTx: IncomingTx,
  windowStart: Date,
  windowEnd: Date,
): Promise<PairResult> {
  // This is a COP credit from PEXTO. Find the matching ARQ USD debit with
  // metadata.fx.copAmountCents within ±0.5% of this tx's amount.
  const copAmount = newTx.amountCents; // positive (credit)
  const tolerance = computeAbsTolerance(copAmount);

  // Look for ARQ transfer_sent txs with copAmountCents in range.
  // We pull candidates with source='gmail_arq' OR source='arq_statement' that
  // have negative amounts (USD debit) and then filter by metadata in application
  // code (JSON extraction in SQL is verbose and less portable for this use case).
  const candidates = await dbc
    .select({
      id: transactions.id,
      amountCents: transactions.amountCents,
      occurredAt: transactions.occurredAt,
      rawData: transactions.rawData,
      counterpartyId: transactions.counterpartyId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, newTx.userId),
        // ARQ debit (negative).
        sql`${transactions.amountCents} < 0`,
        // USD currency (ARQ is USD-denominated).
        eq(transactions.currency, "USD"),
        // Not already paired.
        isNull(transactions.transferGroupId),
        isNull(transactions.deletedAt),
        gte(transactions.occurredAt, windowStart),
        lte(transactions.occurredAt, windowEnd),
        // Source filter: only ARQ-originated txs.
        sql`${transactions.source} IN ('gmail_arq', 'arq_statement')`,
      ),
    )
    .limit(20);

  // Filter by copAmountCents from metadata.
  const matching = candidates.filter((c) => {
    const meta = extractArqMeta(c.rawData as Record<string, unknown> | null);
    if (!meta || meta.copAmountCents === null) return false;
    const diff = meta.copAmountCents - copAmount;
    const absDiff = diff < BigInt(0) ? -diff : diff;
    return absDiff <= tolerance;
  });

  if (matching.length === 0) {
    log.debug(
      {
        txId: newTx.id,
        userId: newTx.userId,
        copAmountCents: copAmount.toString(),
        event: "pair_no_arq_leg",
      },
      "no ARQ debit found for Bancolombia PEXTO credit",
    );
    return { groupId: null, pairedTxId: null };
  }

  // Verify the ARQ leg's recipient_name matches the user.
  const partner = pickClosest(matching, newTx.occurredAt);
  const partnerArqMeta = extractArqMeta(partner.rawData as Record<string, unknown> | null);
  if (partnerArqMeta?.recipientName) {
    const recipientIsUser = await checkRecipientIsUser(
      dbc,
      newTx.userId,
      partnerArqMeta.recipientName,
    );
    if (!recipientIsUser) {
      log.info(
        { txId: newTx.id, userId: newTx.userId, event: "pair_recipient_not_self" },
        "ARQ recipient_name does not match user or aliases; not a self-transfer",
      );
      return { groupId: null, pairedTxId: null };
    }
  }

  // Salary block on this tx's counterparty.
  if (await isSalaryCounterparty(dbc, newTx.userId, newTx.counterpartyId ?? null)) {
    log.info(
      { txId: newTx.id, userId: newTx.userId, event: "pair_blocked_salary" },
      "incoming tx counterparty is_salary=true; skipping pairing",
    );
    return { groupId: null, pairedTxId: null };
  }

  return applyGroupId(dbc, newTx.userId, newTx.id, partner.id);
}

// ---------------------------------------------------------------------------
// Helpers: apply groupId atomically
// ---------------------------------------------------------------------------

async function applyGroupId(
  dbc: DB,
  userId: number,
  txIdA: number,
  txIdB: number,
): Promise<PairResult> {
  const groupId = randomUUID();

  try {
    await dbc.transaction(async (trx) => {
      // Update both legs atomically. Tenant-safe: WHERE includes userId.
      for (const txId of [txIdA, txIdB]) {
        await trx
          .update(transactions)
          .set({
            transferGroupId: groupId,
            channel: "transfer",
            categorySlug: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(transactions.id, txId),
              eq(transactions.userId, userId),
              // Idempotency guard: don't overwrite an already-set group.
              isNull(transactions.transferGroupId),
            ),
          );
      }
    });

    log.info(
      { txIdA, txIdB, userId, groupId, event: "pair_success" },
      "intra-user transfer legs paired",
    );
    return { groupId, pairedTxId: txIdB === txIdA ? null : txIdB };
  } catch (err) {
    log.error(
      { err, txIdA, txIdB, userId, event: "pair_error" },
      "failed to apply transfer_group_id",
    );
    return { groupId: null, pairedTxId: null };
  }
}

// ---------------------------------------------------------------------------
// Helpers: counterparty / salary check
// ---------------------------------------------------------------------------

async function isSalaryCounterparty(
  dbc: DB,
  userId: number,
  counterpartyId: number | null,
): Promise<boolean> {
  if (counterpartyId === null) return false;

  const rows = await dbc
    .select({ isSalary: counterparties.isSalary })
    .from(counterparties)
    .where(
      and(
        // Tenant safety: scope by user_id.
        eq(counterparties.userId, userId),
        eq(counterparties.id, counterpartyId),
      ),
    )
    .limit(1);

  return rows.length > 0 && rows[0].isSalary === true;
}

// ---------------------------------------------------------------------------
// Helpers: cross-currency metadata extraction
// ---------------------------------------------------------------------------

type ArqMeta = {
  recipientName: string | null;
  copAmountCents: bigint | null;
};

/**
 * Extract the ARQ-specific metadata from rawData.
 *
 * Handles both email-derived shape:
 *   { arq: { recipient_name: "..." }, fx: { copAmountCents: "..." } }
 * and statement-merged shape (merged_statement.arq.*).
 */
export function extractArqMeta(rawData: Record<string, unknown> | null): ArqMeta | null {
  if (!rawData) return null;

  // Primary arq block.
  const arqBlock = rawData.arq as Record<string, unknown> | undefined;
  // Merged statement arq override (statement-side recipient_name).
  const mergedArqBlock = (rawData.merged_statement as Record<string, unknown> | undefined)?.arq as
    | Record<string, unknown>
    | undefined;

  const recipientName =
    (mergedArqBlock?.recipient_name_from_statement as string | undefined) ??
    (arqBlock?.recipient_name as string | undefined) ??
    null;

  // COP amount can live in:
  //   - rawData.fx.copAmountCents (email parser — fx block)
  //   - rawData.merged_statement.fx.copAmountCents (statement merge)
  const fxBlock = rawData.fx as Record<string, unknown> | undefined;
  const mergedFxBlock = (rawData.merged_statement as Record<string, unknown> | undefined)?.fx as
    | Record<string, unknown>
    | undefined;

  const rawCop =
    (mergedFxBlock?.copAmountCents as string | undefined) ??
    (fxBlock?.copAmountCents as string | undefined) ??
    null;

  const copAmountCents = rawCop !== null ? BigInt(rawCop) : null;

  // Only return a meta object if we have at least the arq block.
  if (!arqBlock && !mergedArqBlock) return null;

  return { recipientName, copAmountCents };
}

// ---------------------------------------------------------------------------
// Helpers: fiat partner check
// ---------------------------------------------------------------------------

let _fiatPartnerCache: string[] | null = null;
let _cacheLoadedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchArqFiatPartners(dbc: DB): Promise<string[]> {
  const now = Date.now();
  if (_fiatPartnerCache !== null && now - _cacheLoadedAt < CACHE_TTL_MS) {
    return _fiatPartnerCache;
  }

  const rows = await dbc
    .select({ partnerName: fiatPartners.partnerName })
    .from(fiatPartners)
    .where(and(eq(fiatPartners.sourceSystem, "arq"), eq(fiatPartners.active, true)));

  _fiatPartnerCache = rows.map((r) => r.partnerName.toUpperCase());
  _cacheLoadedAt = now;
  return _fiatPartnerCache;
}

/** Exposed for tests so they can bust the in-process cache between runs. */
export function resetFiatPartnerCache(): void {
  _fiatPartnerCache = null;
  _cacheLoadedAt = 0;
}

async function checkIsBancolombiaFromPexto(dbc: DB, tx: IncomingTx): Promise<boolean> {
  if (!tx.counterparty) return false;
  const partners = await fetchArqFiatPartners(dbc);
  const upper = tx.counterparty.toUpperCase();
  return partners.some((p) => upper.includes(p));
}

/**
 * Build a SQL condition that matches transactions whose `merchant`
 * contains one of the fiat partner names (case-insensitive).
 *
 * We use `merchant` because `ingestBancolombiaTransaction` writes the parsed
 * counterparty there. Partners list is already uppercased by fetchArqFiatPartners.
 */
function buildPartnerFilter(partners: string[]): ReturnType<typeof sql> {
  // Build: (upper(merchant) LIKE '%PEXTO COLOMBIA%' OR upper(merchant) LIKE '%OTHER%' ...)
  // We compose using sql template to avoid raw string injection.
  // Partners are server-side constants (from fiat_partners table), not user input.
  if (partners.length === 1) {
    const pattern = `%${partners[0]}%`;
    return sql`upper(${transactions.merchant}) LIKE ${pattern}`;
  }
  // Multiple: combine with sql`... OR ...`.
  // Build each condition fragment and combine them.
  let combined = sql`upper(${transactions.merchant}) LIKE ${`%${partners[0]}%`}`;
  for (const p of partners.slice(1)) {
    combined = sql`${combined} OR upper(${transactions.merchant}) LIKE ${`%${p}%`}`;
  }
  return combined;
}

// ---------------------------------------------------------------------------
// Helpers: user name / alias matching
// ---------------------------------------------------------------------------

/**
 * Returns true if `name` matches the user's own name (users.name) or any
 * of the aliases in user_aliases.
 *
 * Tenant safety: both queries scope to userId.
 * Log-injection safety: `name` is NEVER interpolated into the log message
 * string — only passed as a structured field.
 */
async function checkRecipientIsUser(dbc: DB, userId: number, name: string): Promise<boolean> {
  const normalised = normaliseForMatch(name);

  // Check users.name.
  const userRows = await dbc
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (userRows.length > 0 && normaliseForMatch(userRows[0].name) === normalised) {
    return true;
  }

  // Check user_aliases (tenant-safe: WHERE user_id = userId AND alias = ...).
  const aliasRows = await dbc
    .select({ alias: userAliases.alias })
    .from(userAliases)
    .where(and(eq(userAliases.userId, userId), sql`lower(${userAliases.alias}) = lower(${name})`))
    .limit(1);

  return aliasRows.length > 0;
}

function normaliseForMatch(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Helpers: tolerance + closest candidate
// ---------------------------------------------------------------------------

function computeAbsTolerance(amount: bigint): bigint {
  // ±0.5% of the amount. For 2_104_000 COP → ±10_520 COP.
  // We use integer arithmetic: tolerance = amount * 5 / 1000.
  const raw = ((amount < BigInt(0) ? -amount : amount) * BigInt(5)) / BigInt(1000);
  return raw < BigInt(1) ? BigInt(1) : raw;
}

function pickClosest<T extends { occurredAt: Date }>(candidates: T[], target: Date): T {
  let best = candidates[0];
  let bestDelta = Math.abs(candidates[0].occurredAt.getTime() - target.getTime());
  for (const c of candidates.slice(1)) {
    const delta = Math.abs(c.occurredAt.getTime() - target.getTime());
    if (delta < bestDelta) {
      best = c;
      bestDelta = delta;
    }
  }
  return best;
}

// Re-export constants for use in the migration script.
export { REALTIME_WINDOW_MS, BATCH_WINDOW_MS };
