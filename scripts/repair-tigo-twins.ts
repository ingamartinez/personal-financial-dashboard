/**
 * #1028 repair: link the Tigo twin charges that the exact-amount bijective pass
 * declined, because the amount drifted inside the 1% band and the payer account
 * differed.
 *
 * Every pair below is something the relaxed pass in `gap-detector.ts` would do
 * on its own for that month. Nothing here invents a new judgment:
 *
 *   3220 → #11  (2026-11, $48.239 vs $47.900 baseline, 0.71%, account 6)
 *   3221 → #12  (2026-11, $48.239 vs $47.900 baseline, 0.71%, account 6)
 *   2542 → #11  (2026-08, $47.940 vs $47.900 baseline, 0.08%, account 5)
 *
 * Deliberately excluded:
 *   - tx 2541 (2026-08, $57.460, 20% over baseline) — outside the band, so
 *     linking it would be a guess. It stays unmatched for a one-tap confirm in
 *     the UI.
 *   - tx 3219 (`MERPAGO*PASARELAEMI`) — a descriptor-spelling failure, not a
 *     twin/amount failure. Tracked in #1029.
 *
 * Idempotent: a pair already linked to its target recurring is skipped; a pair
 * linked to a DIFFERENT recurring aborts the run.
 *
 * Usage:
 *   bun run scripts/repair-tigo-twins.ts --dry-run
 *   bun run scripts/repair-tigo-twins.ts
 */

import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb, type DB } from "../src/lib/db";
import { recurringTransactions, transactions } from "../src/lib/db/schema";
import { createLogger } from "../src/lib/logger";
import { claimUnlinkedTx } from "../src/lib/recurring/gap-detector";
import { isWithinAmountTolerance } from "../src/lib/recurring/match-score";
import { recordRecurringLinkObservation } from "../src/lib/recurring/observation-recorder";

const log = createLogger({ module: "repair-tigo-twins" });

const USER_ID = 1;

type PairTarget = {
  txId: number;
  recurringId: number;
  yearMonth: string;
};

const PAIRS: readonly PairTarget[] = [
  { txId: 3220, recurringId: 11, yearMonth: "2026-11" },
  { txId: 3221, recurringId: 12, yearMonth: "2026-11" },
  { txId: 2542, recurringId: 11, yearMonth: "2026-08" },
];

export type PairPlan = PairTarget & {
  txAmountCents: bigint;
  recurringAmountCents: bigint;
};

/** Read-only: resolve every pair and refuse anything outside the expected shape. */
export async function planRepair(
  userId: number,
  pairs: readonly PairTarget[] = PAIRS,
  database: DB = defaultDb,
): Promise<PairPlan[]> {
  const txIds = pairs.map((p) => p.txId);
  const txRows = await database
    .select({
      id: transactions.id,
      recurringId: transactions.recurringId,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
    })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), inArray(transactions.id, txIds)));

  const txById = new Map(txRows.map((r) => [r.id, r]));
  const plans: PairPlan[] = [];

  for (const pair of pairs) {
    const tx = txById.get(pair.txId);
    if (!tx) throw new Error(`tigo_repair_tx_missing:${pair.txId}`);
    if (tx.recurringId !== null && tx.recurringId !== pair.recurringId) {
      throw new Error(`tigo_repair_tx_linked_elsewhere:${pair.txId}:${tx.recurringId}`);
    }

    const [recurring] = await database
      .select({
        amountCents: recurringTransactions.amountCents,
        currency: recurringTransactions.currency,
      })
      .from(recurringTransactions)
      .where(
        and(
          eq(recurringTransactions.userId, userId),
          eq(recurringTransactions.id, pair.recurringId),
        ),
      );
    if (!recurring) throw new Error(`tigo_repair_recurring_missing:${pair.recurringId}`);

    if (
      !isWithinAmountTolerance(
        recurring.amountCents,
        tx.amountCents,
        recurring.currency,
        tx.currency,
      )
    ) {
      throw new Error(`tigo_repair_amount_outside_band:${pair.txId}`);
    }

    if (tx.recurringId === pair.recurringId) continue; // already done — idempotent

    plans.push({
      txId: pair.txId,
      recurringId: pair.recurringId,
      yearMonth: pair.yearMonth,
      txAmountCents: tx.amountCents,
      recurringAmountCents: recurring.amountCents,
    });
  }

  return plans;
}

/** Writes the links with the same primitive the detector uses, so the gap row is cleared too. */
export async function applyRepair(
  userId: number,
  plans: readonly PairPlan[],
  database: DB = defaultDb,
): Promise<number> {
  let linked = 0;
  for (const plan of plans) {
    const claimed = await claimUnlinkedTx(
      userId,
      plan.txId,
      plan.recurringId,
      plan.yearMonth,
      database,
    );
    if (!claimed) continue;
    await recordRecurringLinkObservation(
      {
        userId,
        recurringId: plan.recurringId,
        txId: plan.txId,
        yearMonth: plan.yearMonth,
        manual: true,
      },
      database,
    );
    linked += 1;
  }
  return linked;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const unknown = argv.filter((a) => a !== "--dry-run");
  if (unknown.length > 0) {
    log.error({ event: "tigo_repair_unknown_arg", args: unknown }, "unknown argument");
    process.exit(1);
  }
  const dryRun = argv.includes("--dry-run");

  try {
    const plans = await planRepair(USER_ID);
    log.info(
      {
        dryRun,
        event: "tigo_repair_plan",
        pairs: plans.map((p) => ({
          txId: p.txId,
          recurringId: p.recurringId,
          yearMonth: p.yearMonth,
          txAmountCents: p.txAmountCents.toString(),
          recurringAmountCents: p.recurringAmountCents.toString(),
        })),
      },
      dryRun
        ? `dry run — ${plans.length} pairs, no writes`
        : `about to link ${plans.length} transactions`,
    );

    if (dryRun) process.exit(0);

    const linked = await applyRepair(USER_ID, plans);
    log.info({ event: "tigo_repair_done", linked }, `${linked} transactions linked`);
    await defaultDb.$client.end({ timeout: 1 });
    process.exit(0);
  } catch (err) {
    log.error({ err, event: "tigo_repair_failed" }, "tigo twins repair failed");
    await defaultDb.$client.end({ timeout: 1 }).catch(() => void 0);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
