/**
 * #1029 — link the November EMI charge that arrived under a second gateway
 * descriptor spelling.
 *
 * Usage:
 *   bun scripts/repair-emi-alias-link.ts --dry-run
 *   bun scripts/repair-emi-alias-link.ts
 *
 * "EMI Medicina en Casa" (#15, -152_800_00 cents) linked every month while its
 * bank descriptor read `MERCADO PAGO*PASAREL`. November's charge (tx 3219,
 * 2026-11-23) arrived as `MERPAGO*PASARELAEMI`: its fingerprint matches no
 * learned pattern, and `scoreMatchCandidates()` refuses the amount-only
 * fallback for an extractable-but-unmatched token (the KFC/SmartFit rule). Same
 * merchant, same amount to the cent, one plausible recurring — nothing linked.
 *
 * The identifiers are intentionally fixed: this is a one-shot, audited repair
 * for the single production row in issue #1029. The pre-SELECT refuses any
 * shape other than "this tx is still unlinked and its amount is within 1% of
 * #15's", so re-running after a successful repair is silent on money and the
 * observation/link writes below stay idempotent.
 *
 * Linking through `recordRecurringLinkObservation({ manual: true })` is what
 * re-derives the description fingerprint, so the learned pattern set picks up
 * whatever this descriptor tokenises to.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../src/lib/db";
import { recurringTransactions, transactions } from "../src/lib/db/schema";
import { recordRecurringLinkObservation } from "../src/lib/recurring/observation-recorder";
import { isWithinAmountTolerance } from "../src/lib/recurring/match-score";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "repair-emi-alias-link" });

const USER_ID = 1;
/** The November `MERPAGO*PASARELAEMI` charge from issue #1029. */
const TX_ID = 3219;
/** EMI Medicina en Casa, the recurring that descriptor belongs to. */
const RECURRING_ID = 15;
const YEAR_MONTH = "2026-11";

function parseDryRun(argv: string[]): boolean {
  for (const arg of argv) {
    if (arg === "--dry-run") continue;
    log.error({ arg, event: "repair_emi_alias_unknown_arg" }, "unknown argument");
    process.exit(1);
  }
  return argv.includes("--dry-run");
}

function fail(message: string): never {
  throw new Error(message);
}

async function main(): Promise<void> {
  const dryRun = parseDryRun(process.argv.slice(2));

  // Pre-SELECT: validate the row shape BEFORE any write. A half-applied repair
  // over money is worse than none, so every refusal below aborts the run.
  const [tx] = await db
    .select({
      id: transactions.id,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      descriptionRaw: transactions.descriptionRaw,
      recurringId: transactions.recurringId,
      recurringYearMonth: transactions.recurringYearMonth,
    })
    .from(transactions)
    .where(and(eq(transactions.userId, USER_ID), eq(transactions.id, TX_ID)))
    .limit(1);

  if (!tx) fail(`repair_emi_alias_tx_missing:${TX_ID}`);
  if (tx.recurringId !== null && tx.recurringId !== RECURRING_ID) {
    fail(`repair_emi_alias_already_linked_elsewhere:${TX_ID}:${tx.recurringId}`);
  }
  if (tx.recurringId === RECURRING_ID && tx.recurringYearMonth !== YEAR_MONTH) {
    fail(`repair_emi_alias_unexpected_year_month:${TX_ID}:${tx.recurringYearMonth ?? "null"}`);
  }

  const [recurring] = await db
    .select({
      id: recurringTransactions.id,
      amountCents: recurringTransactions.amountCents,
      currency: recurringTransactions.currency,
      deletedAt: recurringTransactions.deletedAt,
    })
    .from(recurringTransactions)
    .where(
      and(eq(recurringTransactions.userId, USER_ID), eq(recurringTransactions.id, RECURRING_ID)),
    )
    .limit(1);

  if (!recurring) fail(`repair_emi_alias_recurring_missing:${RECURRING_ID}`);
  if (recurring.deletedAt !== null) {
    fail(`repair_emi_alias_recurring_deleted:${RECURRING_ID}`);
  }
  if (
    !isWithinAmountTolerance(recurring.amountCents, tx.amountCents, recurring.currency, tx.currency)
  ) {
    fail(
      `repair_emi_alias_amount_out_of_band:${TX_ID}:${tx.amountCents.toString()}:` +
        `${recurring.amountCents.toString()}`,
    );
  }

  // BigInt never reaches a Pino field directly — Pino cannot serialise it.
  log.info(
    {
      dryRun,
      event: "repair_emi_alias_plan",
      userId: USER_ID,
      txId: TX_ID,
      recurringId: RECURRING_ID,
      yearMonth: YEAR_MONTH,
      txAmountCents: tx.amountCents.toString(),
      recurringAmountCents: recurring.amountCents.toString(),
      currency: tx.currency,
      alreadyLinked: tx.recurringId === RECURRING_ID,
    },
    dryRun ? "dry run — no writes" : "applying EMI alias link repair",
  );
  if (dryRun) return;

  await db.transaction(async (trx) => {
    // `isNull` keeps the update a no-op on a re-run rather than re-stamping a
    // link that is already correct.
    await trx
      .update(transactions)
      .set({ recurringId: RECURRING_ID, recurringYearMonth: YEAR_MONTH, updatedAt: new Date() })
      .where(
        and(
          eq(transactions.userId, USER_ID),
          eq(transactions.id, TX_ID),
          isNull(transactions.recurringId),
        ),
      );
    // Re-derives the description fingerprint for #15 from this descriptor.
    await recordRecurringLinkObservation(
      {
        userId: USER_ID,
        recurringId: RECURRING_ID,
        txId: TX_ID,
        yearMonth: YEAR_MONTH,
        manual: true,
      },
      trx,
    );
  });

  log.info(
    {
      event: "repair_emi_alias_done",
      userId: USER_ID,
      txId: TX_ID,
      recurringId: RECURRING_ID,
      yearMonth: YEAR_MONTH,
    },
    "EMI alias link repair complete",
  );
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    log.error({ err, event: "repair_emi_alias_failed" }, "EMI alias link repair failed");
    process.exit(1);
  });
}
