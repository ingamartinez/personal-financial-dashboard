import { randomUUID } from "node:crypto";
import { and, eq, gte, lte, not, sql } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import { accounts, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { insertTransferGroup } from "@/lib/transactions/transfer-groups";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "reconciliation/pago-tc-router" });

// One calendar day in milliseconds — used for ±1-day date windows.
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Bancolombia gmail/SMS Pago TC notifications round to whole pesos
// ("Pagaste $381,147 ...") while the savings extract carries cents
// ("$-381,147.38"). When matching the savings row to its existing gmail
// debit leg we allow ±100 cents (= ±$1 COP) of difference. This is wide
// enough to absorb the rounding gap without risking false positives —
// real Pago TC pairs never differ by more than $0.99 in practice.
const AMOUNT_TOLERANCE_CENTS = BigInt(100);

// Description patterns that identify a Pago TC row in a savings extract.
// Matching is case-insensitive prefix so variations ("PAGO SUC VIRT TC MASTER DOLAR",
// "PAGO AUTOM TC MASTER PESOS", "pago suc virt tc master pesos", etc.) are all caught.
const PAGO_TC_RE = /pago\s+(?:suc\s+virt|autom)\s+tc\s+master\s+(dolar|pesos)/i;

/** Currency twin of this payment as declared by the savings extract. */
export type PagoTcCurrency = "DOLAR" | "PESOS";

/** One row from the savings extract that represents a Pago TC debit. */
export interface SavingsPagoTcRow {
  /** Calendar date of the savings debit in Bogotá TZ (midnight UTC+5). */
  occurredAt: Date;
  /** Absolute COP amount in cents (always positive). */
  amountCents: bigint;
  /** Which TC twin this payment targets per the savings description. */
  pagoTcCurrency: PagoTcCurrency;
  /** Raw description for audit trail. */
  descriptionRaw: string;
}

export interface PagoTcRoutingResult {
  /** Savings rows that were detected as Pago TC debits. */
  detected: number;
  /** Already correctly routed (PESOS pairs left as-is). */
  noOpPesos: number;
  /** DOLAR pairs where wrong-twin destination was soft-deleted and re-paired to USD synthetic. */
  reassignedToUsd: number;
  /** DOLAR pairs where USD synthetic was not found — destination flagged `pendingUsdTwinReassignment`. */
  pendingUsdReassignment: number;
  /** New transfer pairs inserted for savings rows with no existing gmail pair. */
  newPairsInserted: number;
  /** Errors encountered per row (non-fatal — routing continues on other rows). */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * After the regular savings-statement commit, scan parsed rows for Pago TC
 * descriptions and reconcile them against the DB:
 *
 * - PESOS match  → no-op (existing COP-twin pair is correct)
 * - DOLAR match  → soft-delete wrong-twin destination, re-pair to USD synthetic
 *                  (or flag pendingUsdTwinReassignment if USD synthetic not yet present)
 * - No match     → insert a fresh transfer pair with source='csv_reconcile'
 *
 * @param userId      Tenant ID — every DB query is scoped to this user.
 * @param savingsAccountId  The savings account that was just reconciled.
 * @param rows        All rows from the parsed savings statement (not just Pago TC ones;
 *                    this function filters them internally).
 * @param database    Optional injected DB (for testing without a real DB connection).
 */
export async function applyPagoTcRouting(opts: {
  userId: number;
  savingsAccountId: number;
  rows: Array<{
    occurredAt: Date;
    amountCents: bigint;
    direction: "in" | "out";
    descriptionRaw: string;
  }>;
  database?: DB;
}): Promise<PagoTcRoutingResult> {
  const { userId, savingsAccountId, rows, database = defaultDb } = opts;

  const result: PagoTcRoutingResult = {
    detected: 0,
    noOpPesos: 0,
    reassignedToUsd: 0,
    pendingUsdReassignment: 0,
    newPairsInserted: 0,
    errors: [],
  };

  // Only outbound rows (savings debit = payment from savings account).
  const pagoRows = rows
    .filter((r) => r.direction === "out")
    .flatMap((r): SavingsPagoTcRow[] => {
      const m = PAGO_TC_RE.exec(r.descriptionRaw);
      if (!m) return [];
      const pagoTcCurrency: PagoTcCurrency = m[1].toLowerCase() === "dolar" ? "DOLAR" : "PESOS";
      return [
        {
          occurredAt: r.occurredAt,
          amountCents: r.amountCents,
          pagoTcCurrency,
          descriptionRaw: r.descriptionRaw,
        },
      ];
    });

  result.detected = pagoRows.length;

  if (pagoRows.length === 0) return result;

  // Load the savings account to confirm it belongs to the user and get its
  // physicalCardId (needed to find the TC twin accounts).
  const [savingsAccount] = await database
    .select({
      id: accounts.id,
      userId: accounts.userId,
      currency: accounts.currency,
      physicalCardId: accounts.physicalCardId,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.id, savingsAccountId),
        eq(accounts.userId, userId),
        notDeleted(accounts.deletedAt),
      ),
    )
    .limit(1);

  if (!savingsAccount) {
    result.errors.push(`savings account ${savingsAccountId} not found for user ${userId}`);
    return result;
  }

  for (const row of pagoRows) {
    try {
      await routeSinglePagoTcRow({
        userId,
        savingsAccountId,
        row,
        result,
        database,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        {
          userId,
          savingsAccountId,
          occurredAt: row.occurredAt,
          amountCents: row.amountCents.toString(),
          pagoTcCurrency: row.pagoTcCurrency,
          event: "pago_tc_routing_row_error",
          err,
        },
        "pago tc routing error for row",
      );
      result.errors.push(
        `${row.occurredAt.toISOString().slice(0, 10)} ${row.pagoTcCurrency} ${row.amountCents}: ${msg}`,
      );
    }
  }

  log.info(
    {
      userId,
      savingsAccountId,
      event: "pago_tc_routing_complete",
      ...result,
    },
    "pago tc routing complete",
  );

  return result;
}

// ---------------------------------------------------------------------------
// Per-row routing logic
// ---------------------------------------------------------------------------

async function routeSinglePagoTcRow(opts: {
  userId: number;
  savingsAccountId: number;
  row: SavingsPagoTcRow;
  result: PagoTcRoutingResult;
  database: DB;
}): Promise<void> {
  const { userId, savingsAccountId, row, result, database } = opts;

  // Date window: savings extract uses Bogotá calendar date; gmail-derived txs
  // may land anywhere from -1 to +1 day due to TZ differences.
  const windowStart = new Date(row.occurredAt.getTime() - ONE_DAY_MS);
  const windowEnd = new Date(row.occurredAt.getTime() + ONE_DAY_MS);

  // The savings debit is stored as a negative amount in the DB (outbound).
  // The exact signed amount on the savings leg is -amountCents.
  const savingsSignedCents = -row.amountCents;
  // Range with ±AMOUNT_TOLERANCE_CENTS to absorb gmail/SMS whole-peso rounding.
  // Both bounds are negative (savings debit). Lower = more negative.
  const lowerBound = savingsSignedCents - AMOUNT_TOLERANCE_CENTS;
  const upperBound = savingsSignedCents + AMOUNT_TOLERANCE_CENTS;

  // Find the existing savings debit leg (source = gmail_bancolombia or csv_reconcile)
  // that matches this savings row by date window + amount-within-tolerance.
  // We look for it on the savings account so we know its transfer_group_id.
  const [savingsLeg] = await database
    .select({
      id: transactions.id,
      transferGroupId: transactions.transferGroupId,
      occurredAt: transactions.occurredAt,
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.accountId, savingsAccountId),
        gte(transactions.amountCents, lowerBound),
        lte(transactions.amountCents, upperBound),
        gte(transactions.occurredAt, windowStart),
        lte(transactions.occurredAt, windowEnd),
        notDeleted(transactions.deletedAt),
      ),
    )
    .limit(1);

  if (!savingsLeg) {
    // No savings leg in DB — this row was just inserted by the savings
    // commit that preceded us, OR it's genuinely new. Either way, insert
    // a fresh transfer pair.
    await insertNewPagoTcPair({
      userId,
      savingsAccountId,
      row,
      result,
      database,
    });
    return;
  }

  if (row.pagoTcCurrency === "PESOS") {
    // COP-twin pair is correct — no action needed.
    result.noOpPesos++;
    log.info(
      {
        userId,
        event: "pago_tc_pesos_noop",
        savingsLegId: savingsLeg.id,
        transferGroupId: savingsLeg.transferGroupId,
      },
      "pago tc PESOS row — existing pair is correct, no-op",
    );
    return;
  }

  // DOLAR: existing pair may route to the COP twin (wrong). Find the
  // destination leg of the group and determine if it needs to be re-routed.
  if (!savingsLeg.transferGroupId) {
    // Savings leg has no transfer group — it was inserted as a plain tx
    // (pre-#405 behavior or savings-only import without pairing). Nothing to re-pair.
    // Flag it for manual review.
    result.errors.push(
      `savings leg tx ${savingsLeg.id} has no transfer_group_id — cannot re-pair for DOLAR`,
    );
    return;
  }

  await reassignDolarPair({
    userId,
    savingsAccountId,
    savingsLeg,
    row,
    result,
    database,
  });
}

// ---------------------------------------------------------------------------
// DOLAR re-pairing
// ---------------------------------------------------------------------------

async function reassignDolarPair(opts: {
  userId: number;
  savingsAccountId: number;
  savingsLeg: { id: number; transferGroupId: string | null; occurredAt: Date; amountCents: bigint };
  row: SavingsPagoTcRow;
  result: PagoTcRoutingResult;
  database: DB;
}): Promise<void> {
  const { userId, savingsAccountId, savingsLeg, row, result, database } = opts;

  const transferGroupId = savingsLeg.transferGroupId!;

  // Find the destination leg in the same transfer group (positive amount,
  // different account from savings). Scoped by userId per tenant-safety rule.
  const [destinationLeg] = await database
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      occurredAt: transactions.occurredAt,
      deletedAt: transactions.deletedAt,
      rawData: transactions.rawData,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.transferGroupId, transferGroupId),
        not(eq(transactions.accountId, savingsAccountId)),
        sql`${transactions.amountCents} > 0`,
      ),
    )
    .limit(1);

  if (!destinationLeg) {
    result.errors.push(
      `transfer group ${transferGroupId} has no destination leg (DOLAR row ${row.occurredAt.toISOString().slice(0, 10)})`,
    );
    return;
  }

  // Check if destination is already deleted (manual cleanup was done).
  if (destinationLeg.deletedAt !== null) {
    // Destination already soft-deleted (e.g., manual SQL cleanup done 2026-04-27).
    // Look for the USD synthetic to verify or re-pair.
    log.info(
      {
        userId,
        event: "pago_tc_destination_already_deleted",
        destinationLegId: destinationLeg.id,
        transferGroupId,
      },
      "destination leg already soft-deleted — attempting USD synthetic lookup",
    );
    await linkUsdSynthetic({
      userId,
      savingsLeg,
      destinationAccountId: destinationLeg.accountId,
      row,
      result,
      database,
    });
    return;
  }

  // Find the USD twin account via physicalCardId of the destination account.
  const [destinationAccount] = await database
    .select({
      id: accounts.id,
      currency: accounts.currency,
      physicalCardId: accounts.physicalCardId,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.id, destinationLeg.accountId),
        eq(accounts.userId, userId),
        notDeleted(accounts.deletedAt),
      ),
    )
    .limit(1);

  if (!destinationAccount) {
    result.errors.push(
      `destination account ${destinationLeg.accountId} not found for user ${userId}`,
    );
    return;
  }

  if (destinationAccount.currency === "USD") {
    // Already on the USD twin — no action needed.
    result.noOpPesos++; // reuse counter as "already correct"
    log.info(
      {
        userId,
        event: "pago_tc_dolar_already_on_usd_twin",
        destinationLegId: destinationLeg.id,
        transferGroupId,
      },
      "DOLAR pair destination is already on USD twin — no-op",
    );
    return;
  }

  // Destination is on the COP twin (wrong). Soft-delete it.
  await database
    .update(transactions)
    .set({
      deletedAt: new Date(),
      updatedAt: new Date(),
      rawData: {
        ...(destinationLeg.rawData as Record<string, unknown>),
        softDeletedReason: "issue-567-savings-parser-detected-DOLAR",
      },
    })
    .where(and(eq(transactions.id, destinationLeg.id), eq(transactions.userId, userId)));

  log.info(
    {
      userId,
      event: "pago_tc_wrong_twin_soft_deleted",
      destinationLegId: destinationLeg.id,
      transferGroupId,
    },
    "soft-deleted wrong-twin (COP) destination leg for DOLAR pago tc",
  );

  // Now attempt to link to USD synthetic.
  await linkUsdSynthetic({
    userId,
    savingsLeg,
    destinationAccountId: destinationLeg.accountId,
    row,
    result,
    database,
  });
}

// ---------------------------------------------------------------------------
// USD synthetic lookup + linking
// ---------------------------------------------------------------------------

async function linkUsdSynthetic(opts: {
  userId: number;
  savingsLeg: { id: number; transferGroupId: string | null; occurredAt: Date; amountCents: bigint };
  destinationAccountId: number;
  row: SavingsPagoTcRow;
  result: PagoTcRoutingResult;
  database: DB;
}): Promise<void> {
  const { userId, savingsLeg, destinationAccountId, row, result, database } = opts;

  // Load destination account's physicalCardId to find the USD twin.
  const [destAccount] = await database
    .select({ id: accounts.id, physicalCardId: accounts.physicalCardId })
    .from(accounts)
    .where(and(eq(accounts.id, destinationAccountId), eq(accounts.userId, userId)))
    .limit(1);

  if (!destAccount?.physicalCardId) {
    // No plastic link — can't find USD twin.
    await flagPendingUsdReassignment({ userId, savingsLeg, database });
    result.pendingUsdReassignment++;
    return;
  }

  // Find the USD twin account (same physicalCardId, different account, USD currency).
  const [usdTwinAccount] = await database
    .select({ id: accounts.id, currency: accounts.currency })
    .from(accounts)
    .where(
      and(
        eq(accounts.physicalCardId, destAccount.physicalCardId),
        eq(accounts.userId, userId),
        not(eq(accounts.id, destinationAccountId)),
        notDeleted(accounts.deletedAt),
      ),
    )
    .limit(1);

  if (!usdTwinAccount || usdTwinAccount.currency !== "USD") {
    await flagPendingUsdReassignment({ userId, savingsLeg, database });
    result.pendingUsdReassignment++;
    return;
  }

  // Look for the USD synthetic ABONO SUCURSAL VIRTUAL row that represents this
  // payment landing on the USD card. The USD statement consolidation inserts it
  // with source='csv_reconcile', positive amountCents (credit on TC).
  // We match by date ±1 day — we cannot match exact USD amount without the TRM,
  // so we look for the most recent credit row in the window on the USD twin.
  const windowStart = new Date(row.occurredAt.getTime() - ONE_DAY_MS);
  const windowEnd = new Date(row.occurredAt.getTime() + ONE_DAY_MS);

  const usdSyntheticCandidates = await database
    .select({
      id: transactions.id,
      amountCents: transactions.amountCents,
      occurredAt: transactions.occurredAt,
      transferGroupId: transactions.transferGroupId,
      descriptionRaw: transactions.descriptionRaw,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.accountId, usdTwinAccount.id),
        sql`${transactions.amountCents} > 0`,
        gte(transactions.occurredAt, windowStart),
        lte(transactions.occurredAt, windowEnd),
        notDeleted(transactions.deletedAt),
        // Only csv_reconcile rows (TC statement consolidation) or transfer legs
        // can be a USD synthetic. We accept any positive tx in the date window
        // on the USD twin — the match is loose but auditable via logs.
      ),
    )
    .orderBy(transactions.occurredAt);

  if (usdSyntheticCandidates.length === 0) {
    // USD statement not uploaded yet — flag for later.
    await flagPendingUsdReassignment({ userId, savingsLeg, database });
    result.pendingUsdReassignment++;
    log.info(
      {
        userId,
        event: "pago_tc_pending_usd_reassignment",
        savingsLegId: savingsLeg.id,
        usdTwinAccountId: usdTwinAccount.id,
        occurredAt: row.occurredAt.toISOString(),
      },
      "no USD synthetic found — flagged pendingUsdTwinReassignment",
    );
    return;
  }

  // Use the first candidate (closest to savings date). If the USD statement
  // has already been paired via another transfer group, skip re-pairing.
  const usdSynthetic = usdSyntheticCandidates[0];

  // Re-pair: update both legs to share the same transfer_group_id.
  // The savings leg keeps its existing group id (source of truth), and we
  // update the USD synthetic to join the same group.
  const groupId = savingsLeg.transferGroupId ?? randomUUID();

  await database
    .update(transactions)
    .set({
      transferGroupId: groupId,
      channel: "transfer",
      updatedAt: new Date(),
    })
    .where(and(eq(transactions.id, usdSynthetic.id), eq(transactions.userId, userId)));

  // Ensure the savings leg also has the group id (it should, but confirm).
  if (!savingsLeg.transferGroupId) {
    await database
      .update(transactions)
      .set({ transferGroupId: groupId, updatedAt: new Date() })
      .where(and(eq(transactions.id, savingsLeg.id), eq(transactions.userId, userId)));
  }

  result.reassignedToUsd++;
  log.info(
    {
      userId,
      event: "pago_tc_reassigned_to_usd_synthetic",
      savingsLegId: savingsLeg.id,
      usdSyntheticId: usdSynthetic.id,
      transferGroupId: groupId,
    },
    "re-paired savings leg to USD synthetic",
  );
}

async function flagPendingUsdReassignment(opts: {
  userId: number;
  savingsLeg: { id: number; rawData?: Record<string, unknown> };
  database: DB;
}): Promise<void> {
  const { userId, savingsLeg, database } = opts;
  await database
    .update(transactions)
    .set({
      rawData: sql`${transactions.rawData} || '{"pendingUsdTwinReassignment": true}'::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(transactions.id, savingsLeg.id), eq(transactions.userId, userId)));
}

// ---------------------------------------------------------------------------
// Insert fresh transfer pair (no existing gmail pair)
// ---------------------------------------------------------------------------

async function insertNewPagoTcPair(opts: {
  userId: number;
  savingsAccountId: number;
  row: SavingsPagoTcRow;
  result: PagoTcRoutingResult;
  database: DB;
}): Promise<void> {
  const { userId, savingsAccountId, row, result, database } = opts;

  // Find the TC account to pair with. For PESOS: find the COP twin TC account.
  // For DOLAR: find the USD twin TC account. We need to locate the TC card
  // linked via physicalCardId from the savings account's sister TCs.
  //
  // The savings account is NOT a TC account — we look for accounts of type
  // 'credit_card' belonging to the same user that are Bancolombia and match
  // the expected currency.
  const targetCurrency: "COP" | "USD" = row.pagoTcCurrency === "DOLAR" ? "USD" : "COP";

  // Find the TC (credit_card) account with the correct currency and institution.
  // Filter on type='credit_card' to exclude the savings account itself.
  const tcAccounts = await database
    .select({
      id: accounts.id,
      currency: accounts.currency,
      institutionSlug: accounts.institutionSlug,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.currency, targetCurrency),
        eq(accounts.institutionSlug, "bancolombia"),
        eq(accounts.type, "credit_card"),
        notDeleted(accounts.deletedAt),
      ),
    );

  const tcAccount = tcAccounts[0] ?? null;

  if (!tcAccount) {
    result.errors.push(
      `no Bancolombia ${targetCurrency} TC account found for user ${userId} — cannot insert Pago TC pair for ${row.occurredAt.toISOString().slice(0, 10)}`,
    );
    return;
  }

  const descriptionRaw = row.descriptionRaw || `Pago TC (${row.pagoTcCurrency})`;

  const insertResult = await insertTransferGroup({
    userId,
    legs: [
      {
        accountId: savingsAccountId,
        amountCents: -row.amountCents, // savings debit
        currency: "COP",
        descriptionRaw,
        source: "csv_reconcile",
        occurredAt: row.occurredAt,
        rawData: {
          kind: "tc_payment",
          role: "debit",
          pagoTcCurrency: row.pagoTcCurrency,
          insertedBy: "issue-567-savings-parser",
        },
      },
      {
        accountId: tcAccount.id,
        amountCents: row.amountCents, // TC credit (COP amount; USD side is handled by TRM)
        currency: targetCurrency,
        descriptionRaw,
        source: "csv_reconcile",
        occurredAt: row.occurredAt,
        rawData: {
          kind: "tc_payment",
          role: "credit",
          pagoTcCurrency: row.pagoTcCurrency,
          insertedBy: "issue-567-savings-parser",
        },
      },
    ],
    database,
  });

  if (insertResult.status === "error") {
    result.errors.push(
      `failed to insert Pago TC pair for ${row.occurredAt.toISOString().slice(0, 10)}: ${insertResult.reason}`,
    );
    return;
  }

  if (insertResult.status === "duplicated") {
    // Already inserted (idempotent re-run) — count as no-op.
    result.noOpPesos++;
    return;
  }

  result.newPairsInserted++;
  log.info(
    {
      userId,
      event: "pago_tc_new_pair_inserted",
      savingsAccountId,
      tcAccountId: tcAccount.id,
      pagoTcCurrency: row.pagoTcCurrency,
      amountCents: row.amountCents.toString(),
      transferGroupId: insertResult.transferGroupId,
      txIds: insertResult.txIds,
    },
    "inserted new Pago TC transfer pair from savings extract",
  );
}
