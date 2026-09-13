/**
 * Repair the production links created by the #852 relink incident.
 *
 * Usage:
 *   bun scripts/repair-recurring-4-links.ts --dry-run
 *   bun scripts/repair-recurring-4-links.ts
 *
 * The identifiers are intentionally fixed: this is a one-shot, audited repair
 * for the production rows listed in issue #982. Re-running it is a no-op.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../src/lib/db";
import { recurringGaps, transactions } from "../src/lib/db/schema";
import {
  recordRecurringLinkObservation,
  retractRecurringLinkObservation,
} from "../src/lib/recurring/observation-recorder";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "repair-recurring-4-links" });

const USER_ID = 1;
const RECURRING_ID = 4;
const WRONG_LINKS = [1430, 964, 920, 898, 2422, 2587];
const REPAIRS = [
  { txId: 2393, yearMonth: "2026-07" },
  { txId: 2649, yearMonth: "2026-09" },
];

function parseDryRun(argv: string[]): boolean {
  for (const arg of argv) {
    if (arg === "--dry-run") continue;
    log.error({ arg, event: "repair_recurring_unknown_arg" }, "unknown argument");
    process.exit(1);
  }
  return argv.includes("--dry-run");
}

async function main(): Promise<void> {
  const dryRun = parseDryRun(process.argv.slice(2));
  const ids = [...WRONG_LINKS, ...REPAIRS.map((r) => r.txId)];
  const rows = await db
    .select({
      id: transactions.id,
      recurringId: transactions.recurringId,
      recurringYearMonth: transactions.recurringYearMonth,
    })
    .from(transactions)
    .where(and(eq(transactions.userId, USER_ID), inArray(transactions.id, ids)));

  log.info(
    { dryRun, event: "repair_recurring_plan", recurringId: RECURRING_ID, rows },
    dryRun ? "dry run — no writes" : "applying recurring link repair",
  );
  if (dryRun) return;

  await db.transaction(async (trx) => {
    for (const txId of WRONG_LINKS) {
      const row = rows.find((candidate) => candidate.id === txId);
      if (row?.recurringId !== RECURRING_ID) continue;

      // Match the UI undo order: clear the source link before retracting its
      // observation, otherwise re-derivation sees the tx as still linked (#880).
      await trx
        .update(transactions)
        .set({ recurringId: null, recurringYearMonth: null, updatedAt: new Date() })
        .where(and(eq(transactions.userId, USER_ID), eq(transactions.id, txId)));
      await trx
        .update(recurringGaps)
        .set({ resolution: null, resolutionTxId: null, resolvedAt: null })
        .where(
          and(
            eq(recurringGaps.userId, USER_ID),
            eq(recurringGaps.recurringId, RECURRING_ID),
            eq(recurringGaps.yearMonth, row.recurringYearMonth ?? ""),
            eq(recurringGaps.resolution, "linked"),
          ),
        );
      await retractRecurringLinkObservation(
        { userId: USER_ID, txId, recurringId: RECURRING_ID },
        trx,
      );
    }

    for (const repair of REPAIRS) {
      const row = rows.find((candidate) => candidate.id === repair.txId);
      if (!row || (row.recurringId !== null && row.recurringId !== RECURRING_ID)) continue;
      if (row.recurringId === RECURRING_ID && row.recurringYearMonth === repair.yearMonth) continue;

      await trx
        .update(transactions)
        .set({
          recurringId: RECURRING_ID,
          recurringYearMonth: repair.yearMonth,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(transactions.userId, USER_ID),
            eq(transactions.id, repair.txId),
            isNull(transactions.recurringId),
          ),
        );
      await recordRecurringLinkObservation(
        {
          userId: USER_ID,
          recurringId: RECURRING_ID,
          txId: repair.txId,
          yearMonth: repair.yearMonth,
          manual: true,
        },
        trx,
      );
      await trx
        .update(recurringGaps)
        .set({
          resolution: "linked",
          resolutionTxId: repair.txId,
          resolvedAt: new Date(),
        })
        .where(
          and(
            eq(recurringGaps.userId, USER_ID),
            eq(recurringGaps.recurringId, RECURRING_ID),
            eq(recurringGaps.yearMonth, repair.yearMonth),
            isNull(recurringGaps.resolution),
          ),
        );
    }
  });
  log.info(
    { event: "repair_recurring_done", recurringId: RECURRING_ID },
    "recurring link repair complete",
  );
}

main().catch((err: unknown) => {
  log.error({ err, event: "repair_recurring_failed" }, "recurring link repair failed");
  process.exit(1);
});
