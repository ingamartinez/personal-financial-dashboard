/**
 * Undo the USDC sends that the #1008 retokenize linked to Pago de Arriendo
 * while ARQ lines still fingerprinted as YOU.
 *
 * Usage:
 *   bun scripts/repair-arq-usdc-links.ts --dry-run
 *   bun scripts/repair-arq-usdc-links.ts
 *
 * The identifiers are intentionally fixed: this is a one-shot, audited repair
 * for the production rows listed in issue #1010. A row that is neither still
 * mislinked nor already unlinked aborts before any write. Re-running it is a
 * no-op.
 *
 * Run `bun scripts/backfill-retokenize-patterns.ts --user-id=1` afterwards so
 * the YOU fingerprint re-derives from the clean links.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../src/lib/db";
import { recurringGaps, transactions } from "../src/lib/db/schema";
import { retractRecurringLinkObservation } from "../src/lib/recurring/observation-recorder";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "repair-arq-usdc-links" });

const USER_ID = 1;
const RECURRING_ID = 4;
const WRONG_LINKS = [1911, 1914, 1901];

function parseDryRun(argv: string[]): boolean {
  for (const arg of argv) {
    if (arg === "--dry-run") continue;
    log.error({ arg, event: "repair_arq_links_unknown_arg" }, "unknown argument");
    process.exit(1);
  }
  return argv.includes("--dry-run");
}

async function main(): Promise<void> {
  const dryRun = parseDryRun(process.argv.slice(2));
  const rows = await db
    .select({
      id: transactions.id,
      recurringId: transactions.recurringId,
      recurringYearMonth: transactions.recurringYearMonth,
    })
    .from(transactions)
    .where(and(eq(transactions.userId, USER_ID), inArray(transactions.id, WRONG_LINKS)));

  const unexpected = WRONG_LINKS.filter((txId) => {
    const row = rows.find((candidate) => candidate.id === txId);
    return !row || (row.recurringId !== RECURRING_ID && row.recurringId !== null);
  });
  if (unexpected.length > 0) {
    log.error({ unexpected, rows, event: "repair_arq_links_unexpected_state" }, "aborting");
    process.exit(1);
  }

  log.info(
    { dryRun, event: "repair_arq_links_plan", recurringId: RECURRING_ID, rows },
    dryRun ? "dry run — no writes" : "applying ARQ USDC link repair",
  );
  if (dryRun) return;

  await db.transaction(async (trx) => {
    for (const row of rows) {
      if (row.recurringId !== RECURRING_ID) continue;

      // Match the UI undo order: clear the source link before retracting its
      // observation, otherwise re-derivation sees the tx as still linked (#880).
      await trx
        .update(transactions)
        .set({ recurringId: null, recurringYearMonth: null, updatedAt: new Date() })
        .where(
          and(
            eq(transactions.userId, USER_ID),
            eq(transactions.id, row.id),
            eq(transactions.recurringId, RECURRING_ID),
          ),
        );
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
        { userId: USER_ID, txId: row.id, recurringId: RECURRING_ID },
        trx,
      );
    }
  });
  log.info({ event: "repair_arq_links_done" }, "ARQ USDC link repair complete");
}

main().catch((err: unknown) => {
  log.error({ err, event: "repair_arq_links_failed" }, "ARQ USDC link repair failed");
  process.exit(1);
});
