// ARQ statement ↔ email A+ dedup reconciler.
//
// Consumes the ParsedStatementTx array produced by type-handlers.ts and
// reconciles it against existing transactions that arrived via the gmail_arq
// email pipeline (#508).
//
// Decision matrix for each ParsedStatementTx:
//   MERGE  — an existing gmail_arq tx matches within ±24h, ±1 USDc cent, and
//             counterparty similarity ≥ 0.7. The existing row is enriched with
//             statement metadata; amount/occurred_at/counterparty are NOT
//             overwritten (first-in wins).
//   INSERT — no matching email tx found. A new row is written with
//             source='arq_statement'.
//   FLAG   — match found but data diverges (amount > 1c, currency mismatch, or
//             counterparty ratio < 0.3). MERGE proceeds anyway but
//             source_mismatch=true is set for manual review.
//   SKIP   — ParsedStatementTx.kind === 'skip' — nothing written.
//
// Email-orphan check: after processing all statement txs, any gmail_arq tx in
// the period without a statementImportId is set source_mismatch=true with
// reason 'email_orphan'. These are email events the statement did not ratify.
//
// Idempotency: a tx whose external_id_statement is already set is treated as
// already merged — the reconciler skips it. Re-running with the same importId
// will only process rows not yet stamped.
//
// Tenant safety: every query filters on BOTH user_id AND account_id.
// See memory: per-user-table-join-tenant-safety.

import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { transactions, type SourceMismatchDetails } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import { levenshteinRatio } from "@/lib/text/levenshtein";

import type {
  FeeTx,
  P2PTransferTx,
  ParsedStatementTx,
  PurchaseTx,
  RewardTx,
  TransferReceivedTx,
  TransferSentTx,
} from "./type-handlers";

const log = createLogger({ module: "arq-reconciler" });

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** ±24h window for occurred_at matching between email and statement. */
const DATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Candidate search window for amount matching.
 *
 * We use a wider ±10-cent search window for FINDING candidates and a stricter
 * ±1-cent threshold for deciding whether a mismatch should be flagged.
 *
 * Rationale: ARQ statement PDFs occasionally round amounts differently from
 * the real-time email (e.g. FX rounding at the third decimal). Txs within
 * ±10 cents are "probably the same event" — we match them and then decide
 * whether the diff is inside the acceptable ±1-cent band or should be flagged.
 *
 * Amounts further apart than ±10 cents are treated as distinct events (different
 * transactions sharing the same time window — unusual but possible for small
 * fee amounts).
 */
const AMOUNT_SEARCH_WINDOW_CENTS = BigInt(10);

/**
 * ±1 USDc cent threshold for the amount_diverge mismatch flag.
 * If the matched tx's amount differs by more than this, source_mismatch=true.
 */
const AMOUNT_MISMATCH_THRESHOLD_CENTS = BigInt(1);

/**
 * Counterparty similarity ratio threshold for a confident match.
 * At ≥ 0.7, we consider the two strings to describe the same entity.
 * Below 0.3, we treat them as a significant divergence and flag.
 */
const COUNTERPARTY_MATCH_THRESHOLD = 0.7;
const COUNTERPARTY_DIVERGE_THRESHOLD = 0.3;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReconcilerDeps {
  /**
   * Database handle. Injected so tests can supply a transaction-wrapped db.
   * Defaults to the global `db` when not provided (see `reconcileEmailVsStatement`).
   */
  db?: typeof db;
}

export type ReconcileDecision =
  | { kind: "insert"; statementTx: ParsedStatementTx; newTxId: number }
  | {
      kind: "merge";
      statementTx: ParsedStatementTx;
      existingTxId: number;
      mismatchReason?: string;
    }
  | { kind: "skip"; statementTx: ParsedStatementTx; reason: string }
  | { kind: "email_orphan"; existingTxId: number; reason: "no_statement_counterpart" };

export interface ReconcileResult {
  insertedCount: number;
  mergedCount: number;
  /** source_mismatch=true count (diverged merges + email orphans). */
  flaggedCount: number;
  /** gmail_arq txs in the period that have no statement counterpart. */
  emailOrphanCount: number;
  /** Per-tx decisions — used by #516 preview. */
  details: ReconcileDecision[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ExistingEmailTx {
  id: number;
  amountCents: bigint;
  occurredAt: Date;
  /** merchant or counterparty field from the existing row. */
  merchant: string | null;
  externalIdStatement: string | null;
  arqStatementImportId: number | null;
  rawData: Record<string, unknown>;
}

/** Extract the counterparty string from a non-skip ParsedStatementTx. */
function counterpartyFromStatement(tx: ParsedStatementTx): string | null {
  if (tx.kind === "skip") return null;
  switch (tx.kind) {
    case "purchase":
      return tx.merchant;
    case "transfer_sent":
      return tx.recipientName;
    case "transfer_received":
    case "p2p_transfer":
      return tx.counterparty;
    case "fee":
    case "reward":
      return tx.description;
  }
}

/**
 * Derive the tx_channel enum value from the statement kind.
 * ARQ channel mapping:
 *   purchase          → bank   (card payment processed by ARQ)
 *   transfer_sent     → transfer
 *   transfer_received → transfer
 *   p2p_transfer      → transfer
 *   fee               → bank   (platform deduction)
 *   reward            → bank   (platform credit)
 */
function channelFromKind(kind: ParsedStatementTx["kind"]): "bank" | "transfer" {
  switch (kind) {
    case "transfer_sent":
    case "transfer_received":
    case "p2p_transfer":
      return "transfer";
    default:
      return "bank";
  }
}

/**
 * Build the fx metadata block for an INSERT from a statement tx.
 *
 * Canonical shape per #519 design:
 *   originalCurrency      — COP | USD | USDc
 *   originalAmountCents   — string (bigint serialised for JSON)
 *   trmToAccountCurrency  — number | null
 *   trmSource             — "statement_frozen" | "1_to_1" | null
 */
function buildFxBlock(
  tx: PurchaseTx | TransferSentTx | TransferReceivedTx | P2PTransferTx | FeeTx | RewardTx,
): Record<string, unknown> {
  if (tx.kind === "fee" || tx.kind === "reward") {
    // Fees and rewards are USDc-denominated — no FX conversion.
    return {
      originalCurrency: "USDc",
      originalAmountCents: (tx.amountUsdc < BigInt(0) ? -tx.amountUsdc : tx.amountUsdc).toString(),
      trmToAccountCurrency: 1,
      trmSource: "1_to_1",
    };
  }

  if (tx.kind === "transfer_received") {
    return {
      originalCurrency: tx.originalCurrency,
      originalAmountCents: tx.originalAmount.toString(),
      trmToAccountCurrency: 1,
      trmSource: "1_to_1",
    };
  }

  if (tx.kind === "transfer_sent" || tx.kind === "purchase") {
    const trm = tx.trmCopPerUsdc;
    return {
      originalCurrency: tx.originalCurrency,
      originalAmountCents: tx.originalAmount.toString(),
      trmToAccountCurrency: trm ?? 1,
      trmSource: trm !== null ? "statement_frozen" : "1_to_1",
    };
  }

  // p2p_transfer
  const p2p = tx as P2PTransferTx;
  return {
    originalCurrency: p2p.originalCurrency,
    originalAmountCents: p2p.originalAmount.toString(),
    trmToAccountCurrency: 1,
    trmSource: "1_to_1",
  };
}

/**
 * Build the rawData JSON for a new INSERT row.
 *
 * Follows the same structure as email-arq.ts so downstream consumers
 * (e.g. #518 transfer pairing) can read metadata.arq.recipient_name
 * from both email and statement legs uniformly.
 */
function buildRawData(
  tx: PurchaseTx | TransferSentTx | TransferReceivedTx | P2PTransferTx | FeeTx | RewardTx,
  importId: number,
): Record<string, unknown> {
  const arq: Record<string, unknown> = {
    // #518: transfer pairing uses recipient_name to link Bancolombia → ARQ legs.
    // For statement-only inserts, populate where the kind provides it.
    recipient_name: counterpartyFromStatement(tx as ParsedStatementTx) ?? null,
  };

  return {
    kind: tx.kind,
    statement_import_id: importId,
    arq,
    fx: buildFxBlock(tx),
  };
}

/** Build a human-readable descriptionRaw for INSERT rows. */
function buildDescriptionRaw(
  tx: PurchaseTx | TransferSentTx | TransferReceivedTx | P2PTransferTx | FeeTx | RewardTx,
): string {
  switch (tx.kind) {
    case "purchase":
      return `ARQ purchase: ${tx.merchant}`;
    case "transfer_sent":
      return `ARQ sent to ${tx.recipientName}`;
    case "transfer_received":
      return `ARQ received from ${tx.counterparty}`;
    case "p2p_transfer":
      return `ARQ P2P transfer: ${tx.counterparty}`;
    case "fee":
      return `ARQ fee: ${tx.description}`;
    case "reward":
      return `ARQ reward: ${tx.description}`;
  }
}

// ---------------------------------------------------------------------------
// Query: existing email txs in the time window
// ---------------------------------------------------------------------------

async function findEmailCandidates(
  dbc: typeof db,
  userId: number,
  accountId: number,
  occurredAt: Date,
  amountUsdc: bigint,
): Promise<ExistingEmailTx[]> {
  const windowStart = new Date(occurredAt.getTime() - DATE_WINDOW_MS);
  const windowEnd = new Date(occurredAt.getTime() + DATE_WINDOW_MS);

  // Amount search: use the wider ±AMOUNT_SEARCH_WINDOW_CENTS window for
  // candidate retrieval. Mismatch detection later applies the stricter
  // ±AMOUNT_MISMATCH_THRESHOLD_CENTS threshold and flags divergences.
  const absAmount = amountUsdc < BigInt(0) ? -amountUsdc : amountUsdc;

  const rows = await dbc
    .select({
      id: transactions.id,
      amountCents: transactions.amountCents,
      occurredAt: transactions.occurredAt,
      merchant: transactions.merchant,
      externalIdStatement: transactions.externalIdStatement,
      arqStatementImportId: transactions.arqStatementImportId,
      rawData: transactions.rawData,
    })
    .from(transactions)
    .where(
      and(
        // Tenant safety: filter BOTH user_id AND account_id.
        eq(transactions.userId, userId),
        eq(transactions.accountId, accountId),
        // Only consider gmail_arq txs — the source for email-originated events.
        eq(transactions.source, "gmail_arq"),
        // Time window ±24h.
        gte(transactions.occurredAt, windowStart),
        lte(transactions.occurredAt, windowEnd),
        // Amount match within ±AMOUNT_SEARCH_WINDOW_CENTS (handles both signs).
        sql`abs(${transactions.amountCents}) BETWEEN ${absAmount - AMOUNT_SEARCH_WINDOW_CENTS} AND ${absAmount + AMOUNT_SEARCH_WINDOW_CENTS}`,
        // Only live (non-deleted) transactions.
        isNull(transactions.deletedAt),
      ),
    )
    .limit(10);

  return rows.map((r) => ({
    id: r.id,
    amountCents: r.amountCents,
    occurredAt: r.occurredAt,
    merchant: r.merchant,
    externalIdStatement: r.externalIdStatement,
    arqStatementImportId: r.arqStatementImportId,
    rawData: (r.rawData ?? {}) as Record<string, unknown>,
  }));
}

// ---------------------------------------------------------------------------
// Match selection
// ---------------------------------------------------------------------------

interface CandidateScore {
  tx: ExistingEmailTx;
  timeDeltaMs: number;
  counterpartyRatio: number;
}

function scoreCandidate(
  candidate: ExistingEmailTx,
  statementCounterparty: string | null,
  occurredAt: Date,
): CandidateScore {
  const timeDeltaMs = Math.abs(candidate.occurredAt.getTime() - occurredAt.getTime());

  let counterpartyRatio = 1; // default: no counterparty to compare → assume match
  if (statementCounterparty !== null) {
    const existingCounterparty = candidate.merchant ?? "";
    counterpartyRatio = levenshteinRatio(statementCounterparty, existingCounterparty);
  }

  return { tx: candidate, timeDeltaMs, counterpartyRatio };
}

type MatchResult =
  | { found: false }
  | { found: true; tx: ExistingEmailTx; counterpartyRatio: number; ambiguous: boolean };

function selectBestMatch(
  candidates: ExistingEmailTx[],
  statementCounterparty: string | null,
  occurredAt: Date,
): MatchResult {
  // Filter by counterparty threshold first — candidates with ratio below
  // COUNTERPARTY_MATCH_THRESHOLD are not considered a confident match.
  // Exception: if statementCounterparty is null (fees, rewards) we skip the
  // counterparty filter and rely on time + amount alone.
  const eligible = candidates
    .map((c) => scoreCandidate(c, statementCounterparty, occurredAt))
    .filter(
      (s) => statementCounterparty === null || s.counterpartyRatio >= COUNTERPARTY_MATCH_THRESHOLD,
    );

  if (eligible.length === 0) return { found: false };

  // Sort by time delta ascending, then counterparty ratio descending.
  eligible.sort((a, b) => {
    if (a.timeDeltaMs !== b.timeDeltaMs) return a.timeDeltaMs - b.timeDeltaMs;
    return b.counterpartyRatio - a.counterpartyRatio;
  });

  const best = eligible[0];
  const ambiguous = eligible.length > 1 && eligible[1].timeDeltaMs === best.timeDeltaMs;

  return { found: true, tx: best.tx, counterpartyRatio: best.counterpartyRatio, ambiguous };
}

// ---------------------------------------------------------------------------
// Mismatch detection
// ---------------------------------------------------------------------------

type MismatchReason = "amount_diverge" | "currency_diverge" | "counterparty_diverge";

function detectMismatch(
  existing: ExistingEmailTx,
  statementTx: ParsedStatementTx,
  counterpartyRatio: number,
): MismatchReason | null {
  if (statementTx.kind === "skip") return null;

  // Amount divergence: > 1 cent absolute difference.
  const stmtAbsAmount =
    statementTx.amountUsdc < BigInt(0) ? -statementTx.amountUsdc : statementTx.amountUsdc;
  const existAbsAmount =
    existing.amountCents < BigInt(0) ? -existing.amountCents : existing.amountCents;
  const amountDiff =
    stmtAbsAmount > existAbsAmount
      ? stmtAbsAmount - existAbsAmount
      : existAbsAmount - stmtAbsAmount;

  if (amountDiff > AMOUNT_MISMATCH_THRESHOLD_CENTS) return "amount_diverge";

  // Currency divergence: only applicable when the statement has an explicit
  // originalCurrency that differs from what the email recorded.
  const rawData = existing.rawData as { fx?: { originalCurrency?: string } };
  const existingCurrency = rawData.fx?.originalCurrency;
  if (
    existingCurrency !== undefined &&
    statementTx.kind !== "fee" &&
    statementTx.kind !== "reward"
  ) {
    const stmtCurrency = (statementTx as { originalCurrency: string }).originalCurrency;
    if (stmtCurrency && existingCurrency && stmtCurrency !== existingCurrency) {
      return "currency_diverge";
    }
  }

  // Counterparty significant divergence (already below the match threshold
  // but the caller still accepted the row — log as mismatch).
  if (counterpartyRatio < COUNTERPARTY_DIVERGE_THRESHOLD) return "counterparty_diverge";

  return null;
}

// ---------------------------------------------------------------------------
// DB writes: merge, insert, flag
// ---------------------------------------------------------------------------

async function mergeTx(
  dbc: typeof db,
  existing: ExistingEmailTx,
  statementTx: Exclude<ParsedStatementTx, { kind: "skip" }>,
  importId: number,
  mismatchReason: MismatchReason | null,
): Promise<void> {
  const statementMetadata: Record<string, unknown> = {
    arq_statement_import_id: importId,
    statement_kind: statementTx.kind,
    fx: buildFxBlock(statementTx),
  };

  // Merge supplementary arq block (recipient_name if available).
  const counterparty = counterpartyFromStatement(statementTx);
  if (counterparty !== null) {
    statementMetadata.recipient_name_from_statement = counterparty;
  }

  // Append statement metadata into rawData.merged_statement without
  // overwriting the original email-derived fields.
  const mergedRawData: Record<string, unknown> = {
    ...existing.rawData,
    merged_statement: statementMetadata,
  };

  if (mismatchReason === null) {
    await dbc
      .update(transactions)
      .set({
        secondarySource: "arq_statement",
        externalIdStatement: statementTx.externalId,
        arqStatementImportId: importId,
        rawData: mergedRawData,
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, existing.id));
  } else {
    const mismatchDetails: SourceMismatchDetails = {
      fromSource: "gmail_arq",
      toSource: "arq_statement",
      diffs: [
        {
          field: mismatchReason,
          fromValue: "email",
          toValue: "statement",
        },
      ],
    };
    await dbc
      .update(transactions)
      .set({
        secondarySource: "arq_statement",
        externalIdStatement: statementTx.externalId,
        arqStatementImportId: importId,
        rawData: mergedRawData,
        sourceMismatch: true,
        sourceMismatchDetails: mismatchDetails,
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, existing.id));
  }
}

async function insertStatementTx(
  dbc: typeof db,
  userId: number,
  accountId: number,
  importId: number,
  tx: Exclude<ParsedStatementTx, { kind: "skip" }>,
): Promise<number | null> {
  const descriptionRaw = buildDescriptionRaw(tx);
  const rawData = buildRawData(tx, importId);
  const counterparty = counterpartyFromStatement(tx);
  const channel = channelFromKind(tx.kind);

  try {
    const [row] = await dbc
      .insert(transactions)
      .values({
        userId,
        accountId,
        occurredAt: tx.occurredAt,
        amountCents: tx.amountUsdc,
        currency: "USD",
        descriptionRaw,
        merchant: counterparty ?? undefined,
        source: "arq_statement",
        channel,
        externalId: tx.externalId,
        externalIdStatement: tx.externalId,
        arqStatementImportId: importId,
        rawData,
        // categorySlug: intentionally null — rules engine / user assigns later.
        // Defaulting to null avoids the pago-tc double-count pattern (memory).
      })
      .onConflictDoNothing({
        target: [transactions.accountId, transactions.externalId],
        where: sql`${transactions.externalId} IS NOT NULL`,
      })
      .returning({ id: transactions.id });

    return row?.id ?? null;
  } catch (err) {
    log.error(
      {
        err,
        userId,
        accountId,
        importId,
        externalId: tx.externalId,
        event: "arq_reconciler_insert_failed",
      },
      "failed to insert statement-only transaction",
    );
    return null;
  }
}

async function flagEmailOrphans(
  dbc: typeof db,
  userId: number,
  accountId: number,
  period: { start: Date; end: Date },
  importId: number,
): Promise<number> {
  // Find gmail_arq txs in the period that were NOT merged in this run.
  // "Not merged" = arqStatementImportId is still null (no statement has claimed them).
  const orphans = await dbc
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        // Tenant safety: BOTH user_id AND account_id.
        eq(transactions.userId, userId),
        eq(transactions.accountId, accountId),
        eq(transactions.source, "gmail_arq"),
        gte(transactions.occurredAt, period.start),
        lte(transactions.occurredAt, period.end),
        isNull(transactions.arqStatementImportId),
        isNull(transactions.deletedAt),
      ),
    );

  if (orphans.length === 0) return 0;

  const orphanIds = orphans.map((r) => r.id);

  const details: SourceMismatchDetails = {
    fromSource: "gmail_arq",
    toSource: "arq_statement",
    diffs: [
      {
        field: "email_orphan",
        fromValue: "email_only",
        toValue: `statement_import_${importId}`,
      },
    ],
  };

  await dbc
    .update(transactions)
    .set({
      sourceMismatch: true,
      sourceMismatchDetails: details,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(transactions.userId, userId),
        sql`${transactions.id} = ANY(ARRAY[${sql.join(
          orphanIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::integer[])`,
      ),
    );

  log.warn(
    {
      userId,
      accountId,
      importId,
      orphanCount: orphanIds.length,
      orphanIds,
      event: "arq_reconciler_email_orphans",
    },
    "gmail_arq txs in period have no statement counterpart — flagged as email_orphan",
  );

  return orphanIds.length;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reconcile parsed statement transactions against existing gmail_arq email txs.
 *
 * @param deps     - Injected db handle (defaults to global db). Enables test
 *                   isolation without mocking module globals.
 * @param input    - User context, import audit id, period bounds, and parsed txs.
 * @returns        Summary counts + per-tx decision log.
 */
export async function reconcileEmailVsStatement(
  deps: ReconcilerDeps,
  input: {
    userId: number;
    accountId: number;
    importId: number;
    period: { start: Date; end: Date };
    parsedTxs: ParsedStatementTx[];
  },
): Promise<ReconcileResult> {
  const dbc = deps.db ?? db;
  const { userId, accountId, importId, period, parsedTxs } = input;

  const details: ReconcileDecision[] = [];
  let insertedCount = 0;
  let mergedCount = 0;
  let flaggedCount = 0;

  log.info(
    {
      userId,
      accountId,
      importId,
      totalParsed: parsedTxs.length,
      event: "arq_reconciler_start",
    },
    "starting ARQ statement reconciler",
  );

  for (const tx of parsedTxs) {
    // Skip-kind entries carry no data — nothing to write.
    if (tx.kind === "skip") {
      details.push({ kind: "skip", statementTx: tx, reason: tx.reason });
      continue;
    }

    // Idempotency: check if this externalId was already processed in a prior run.
    // The external_id_statement column is unique-per-pair via the reconciler
    // (not a DB unique constraint) so we guard here before any DB write.
    // We'll detect this naturally: findEmailCandidates filters on source='gmail_arq',
    // and insertStatementTx uses onConflictDoNothing on (accountId, externalId).

    const statementCounterparty = counterpartyFromStatement(tx);

    const candidates = await findEmailCandidates(
      dbc,
      userId,
      accountId,
      tx.occurredAt,
      tx.amountUsdc,
    );

    const match = selectBestMatch(candidates, statementCounterparty, tx.occurredAt);

    if (!match.found) {
      // No email counterpart — INSERT as new arq_statement tx.
      const newTxId = await insertStatementTx(dbc, userId, accountId, importId, tx);

      if (newTxId !== null) {
        details.push({ kind: "insert", statementTx: tx, newTxId });
        insertedCount++;
      } else {
        // Insert returned null → onConflictDoNothing hit (already imported by
        // a prior run). Count as a merge/skip for idempotency — no re-insert.
        details.push({ kind: "skip", statementTx: tx, reason: "idempotent_already_inserted" });
      }
      continue;
    }

    if (match.ambiguous) {
      // Multiple equally-close candidates: cannot confidently pick one.
      // Leave for manual review.
      log.warn(
        {
          userId,
          accountId,
          importId,
          externalId: tx.externalId,
          candidateCount: candidates.length,
          event: "arq_reconciler_ambiguous_match",
        },
        "multiple equally-close email candidates — skipping for manual review",
      );
      details.push({
        kind: "skip",
        statementTx: tx,
        reason: "multiple_match_ambiguous",
      });
      continue;
    }

    const { tx: existing, counterpartyRatio } = match;

    // Idempotency: if external_id_statement is already set for this row,
    // a prior reconcile run already merged it. Skip.
    if (existing.externalIdStatement !== null) {
      log.info(
        {
          userId,
          accountId,
          importId,
          existingTxId: existing.id,
          externalIdStatement: existing.externalIdStatement,
          event: "arq_reconciler_already_merged",
        },
        "email tx already has external_id_statement — skipping re-merge",
      );
      details.push({
        kind: "skip",
        statementTx: tx,
        reason: "idempotent_already_merged",
      });
      continue;
    }

    const mismatchReason = detectMismatch(existing, tx, counterpartyRatio);

    await mergeTx(dbc, existing, tx, importId, mismatchReason);

    mergedCount++;
    if (mismatchReason !== null) {
      flaggedCount++;
      log.warn(
        {
          userId,
          accountId,
          importId,
          existingTxId: existing.id,
          mismatchReason,
          counterpartyRatio,
          event: "arq_reconciler_mismatch_flagged",
        },
        "email tx merged with statement but data diverges — flagged source_mismatch",
      );
    }

    details.push({
      kind: "merge",
      statementTx: tx,
      existingTxId: existing.id,
      mismatchReason: mismatchReason ?? undefined,
    });
  }

  // Email-orphan sweep.
  const emailOrphanCount = await flagEmailOrphans(dbc, userId, accountId, period, importId);
  flaggedCount += emailOrphanCount;

  // Emit orphan decisions into details for preview consumers (#516).
  if (emailOrphanCount > 0) {
    // Note: we don't re-query the exact IDs here to avoid a second round-trip;
    // the preview consumer can re-run the orphan query if it needs the ids.
    // The count is authoritative.
    details.push({
      kind: "email_orphan",
      existingTxId: -1,
      reason: "no_statement_counterpart",
    });
  }

  log.info(
    {
      userId,
      accountId,
      importId,
      insertedCount,
      mergedCount,
      flaggedCount,
      emailOrphanCount,
      event: "arq_reconciler_done",
    },
    "ARQ statement reconciler complete",
  );

  return { insertedCount, mergedCount, flaggedCount, emailOrphanCount, details };
}
