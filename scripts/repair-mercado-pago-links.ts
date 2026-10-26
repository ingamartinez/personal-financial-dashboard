/**
 * Repair the production links that Mercado Pago charges got before #1006.
 *
 * Usage:
 *   bun scripts/repair-mercado-pago-links.ts --dry-run
 *   bun scripts/repair-mercado-pago-links.ts
 *
 * The identifiers are intentionally fixed: this is a one-shot, audited repair
 * for the production rows listed in issue #1008. Every row must be either in
 * its pre-repair state or already repaired; anything else aborts before a
 * single write. Re-running it is a no-op.
 *
 * Run `bun scripts/backfill-retokenize-patterns.ts --user-id=1` afterwards so
 * the fingerprints re-derive from the clean links.
 */

import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "../src/lib/db";
import { recurringGaps, transactions } from "../src/lib/db/schema";
import {
  recordRecurringLinkObservation,
  retractRecurringLinkObservation,
} from "../src/lib/recurring/observation-recorder";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "repair-mercado-pago-links" });

const USER_ID = 1;
const EMI = 15;
const DISNEY = 27;
const MAX = 26;

const WRONG_LINKS: { txId: number; recurringId: number }[] = [
  { txId: 2896, recurringId: 6 },
  { txId: 1424, recurringId: EMI },
  { txId: 1335, recurringId: EMI },
  { txId: 1045, recurringId: EMI },
  { txId: 1690, recurringId: 25 },
  { txId: 2476, recurringId: 25 },
  { txId: 1020, recurringId: MAX },
  { txId: 1243, recurringId: MAX },
  { txId: 2868, recurringId: MAX },
  { txId: 3032, recurringId: MAX },
  { txId: 922, recurringId: DISNEY },
];
const REPAIRS: { txId: number; recurringId: number; yearMonth: string }[] = [
  { txId: 2868, recurringId: EMI, yearMonth: "2026-09" },
  { txId: 3032, recurringId: DISNEY, yearMonth: "2026-10" },
  { txId: 3011, recurringId: MAX, yearMonth: "2026-09" },
];

type Row = { id: number; recurringId: number | null; recurringYearMonth: string | null };

function parseDryRun(argv: string[]): boolean {
  for (const arg of argv) {
    if (arg === "--dry-run") continue;
    log.error({ arg, event: "repair_mp_links_unknown_arg" }, "unknown argument");
    process.exit(1);
  }
  return argv.includes("--dry-run");
}

function isRepaired(row: Row, repair: (typeof REPAIRS)[number]): boolean {
  return row.recurringId === repair.recurringId && row.recurringYearMonth === repair.yearMonth;
}

/** Every row must be pre-repair or already repaired; returns why not, else null. */
function unexpectedState(rows: Row[]): string | null {
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const wrong of WRONG_LINKS) {
    const row = byId.get(wrong.txId);
    if (!row) return `tx ${wrong.txId} not found`;
    const repair = REPAIRS.find((r) => r.txId === wrong.txId);
    const done = repair ? isRepaired(row, repair) : row.recurringId === null;
    if (row.recurringId !== wrong.recurringId && !done) {
      return `tx ${wrong.txId} is linked to ${row.recurringId}, expected ${wrong.recurringId}`;
    }
  }
  for (const repair of REPAIRS) {
    const row = byId.get(repair.txId);
    if (!row) return `tx ${repair.txId} not found`;
    const from = WRONG_LINKS.find((w) => w.txId === repair.txId)?.recurringId ?? null;
    if (row.recurringId !== from && !isRepaired(row, repair)) {
      return `tx ${repair.txId} is linked to ${row.recurringId}, expected ${from}`;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const dryRun = parseDryRun(process.argv.slice(2));
  const ids = [...new Set([...WRONG_LINKS, ...REPAIRS].map((r) => r.txId))];
  const rows = await db
    .select({
      id: transactions.id,
      recurringId: transactions.recurringId,
      recurringYearMonth: transactions.recurringYearMonth,
    })
    .from(transactions)
    .where(and(eq(transactions.userId, USER_ID), inArray(transactions.id, ids)));

  const problem = unexpectedState(rows);
  if (problem) {
    log.error({ problem, rows, event: "repair_mp_links_unexpected_state" }, "aborting, no writes");
    process.exit(1);
  }

  log.info(
    { dryRun, event: "repair_mp_links_plan", wrongLinks: WRONG_LINKS, repairs: REPAIRS, rows },
    dryRun ? "dry run — no writes" : "applying Mercado Pago link repair",
  );
  if (dryRun) return;

  await db.transaction(async (trx) => {
    for (const { txId, recurringId } of WRONG_LINKS) {
      const row = rows.find((candidate) => candidate.id === txId);
      if (row?.recurringId !== recurringId) continue;

      // Match the UI undo order: clear the source link before retracting its
      // observation, otherwise re-derivation sees the tx as still linked (#880).
      await trx
        .update(transactions)
        .set({ recurringId: null, recurringYearMonth: null, updatedAt: new Date() })
        .where(
          and(
            eq(transactions.userId, USER_ID),
            eq(transactions.id, txId),
            eq(transactions.recurringId, recurringId),
          ),
        );
      await trx
        .update(recurringGaps)
        .set({ resolution: null, resolutionTxId: null, resolvedAt: null })
        .where(
          and(
            eq(recurringGaps.userId, USER_ID),
            eq(recurringGaps.recurringId, recurringId),
            eq(recurringGaps.yearMonth, row.recurringYearMonth ?? ""),
            eq(recurringGaps.resolution, "linked"),
          ),
        );
      await retractRecurringLinkObservation({ userId: USER_ID, txId, recurringId }, trx);
    }

    for (const repair of REPAIRS) {
      const row = rows.find((candidate) => candidate.id === repair.txId);
      if (!row || isRepaired(row, repair)) continue;

      // The target slot must be free, or the occurrence would count twice.
      const [occupant] = await trx
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, USER_ID),
            eq(transactions.recurringId, repair.recurringId),
            eq(transactions.recurringYearMonth, repair.yearMonth),
            ne(transactions.id, repair.txId),
          ),
        )
        .limit(1);
      if (occupant) {
        throw new Error(
          `slot ${repair.recurringId}/${repair.yearMonth} already holds tx ${occupant.id}`,
        );
      }

      await trx
        .update(transactions)
        .set({
          recurringId: repair.recurringId,
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
          recurringId: repair.recurringId,
          txId: repair.txId,
          yearMonth: repair.yearMonth,
          manual: true,
        },
        trx,
      );
      await trx
        .update(recurringGaps)
        .set({ resolution: "linked", resolutionTxId: repair.txId, resolvedAt: new Date() })
        .where(
          and(
            eq(recurringGaps.userId, USER_ID),
            eq(recurringGaps.recurringId, repair.recurringId),
            eq(recurringGaps.yearMonth, repair.yearMonth),
            isNull(recurringGaps.resolution),
          ),
        );
    }
  });
  log.info({ event: "repair_mp_links_done" }, "Mercado Pago link repair complete");
}

main().catch((err: unknown) => {
  log.error({ err, event: "repair_mp_links_failed" }, "Mercado Pago link repair failed");
  process.exit(1);
});
