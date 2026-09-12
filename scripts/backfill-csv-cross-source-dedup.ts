// #921: repair historical CSV reconciliation duplicates.
// Dry-run by default; writes require --apply. Only strict 1:1 source pairs are
// eligible. Same-source rows and ambiguous clusters are reported and skipped.

import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import { createLogger } from "../src/lib/logger";
import { collapseCsvCandidate, isStrictOneToOne } from "./csv-cross-source-dedup";

const log = createLogger({ module: "backfill-csv-cross-source-dedup" });

type Candidate = {
  csv_id: number;
  live_id: number;
  user_id: number;
  account_id: number;
  live_source: "gmail_bancolombia" | "sms";
  csv_amount_cents: string;
  live_amount_cents: string;
  csv_occurred_at: Date | string;
  live_occurred_at: Date | string;
  csv_merchant: string | null;
  live_merchant: string | null;
  statement_import_id: number | null;
  csv_raw_data: Record<string, unknown> | null;
};

function parseArgs(argv: string[]): { apply: boolean; userId: number | null } {
  let apply = false;
  let userId: number | null = null;
  for (const arg of argv.slice(2)) {
    if (arg === "--apply") apply = true;
    else {
      const match = arg.match(/^--user-id=(\d+)$/);
      if (match) userId = Number(match[1]);
      else log.warn({ arg, event: "csv_dedup_unknown_arg" }, "unknown flag — ignored");
    }
  }
  return { apply, userId };
}

async function main(): Promise<void> {
  const { apply, userId } = parseArgs(process.argv);
  const rows = await db.execute<Candidate>(sql`
    SELECT c.id AS csv_id, l.id AS live_id, c.user_id, c.account_id,
           l.source AS live_source, c.amount_cents::text AS csv_amount_cents,
           l.amount_cents::text AS live_amount_cents, c.occurred_at AS csv_occurred_at,
           l.occurred_at AS live_occurred_at, c.merchant AS csv_merchant,
           l.merchant AS live_merchant, c.statement_import_id, c.raw_data AS csv_raw_data
    FROM transactions c
    JOIN transactions l ON l.user_id = c.user_id AND l.account_id = c.account_id
      AND l.source IN ('gmail_bancolombia', 'sms') AND l.deleted_at IS NULL
      AND (l.statement_import_id IS NULL OR l.statement_import_id = c.statement_import_id)
      AND l.amount_cents = c.amount_cents
      AND l.occurred_at BETWEEN c.occurred_at - interval '1 day'
                            AND c.occurred_at + interval '1 day'
    WHERE c.source = 'csv_reconcile' AND c.deleted_at IS NULL
      ${userId === null ? sql`` : sql`AND c.user_id = ${userId}`}
    ORDER BY c.user_id, c.occurred_at, c.id
  `);
  const csvCounts = new Map<number, number>();
  const liveCounts = new Map<number, number>();
  for (const row of rows) {
    csvCounts.set(row.csv_id, (csvCounts.get(row.csv_id) ?? 0) + 1);
    liveCounts.set(row.live_id, (liveCounts.get(row.live_id) ?? 0) + 1);
  }
  let eligible = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!isStrictOneToOne(row, csvCounts, liveCounts)) {
      skipped++;
      log.warn(
        { ...row, apply, event: "csv_dedup_ambiguous" },
        "skipping ambiguous CSV duplicate candidate",
      );
      continue;
    }
    eligible++;
    log.info(
      { ...row, apply, event: "csv_dedup_candidate" },
      apply
        ? "collapsing historical CSV duplicate"
        : "[dry-run] would collapse historical CSV duplicate",
    );
    if (apply) await collapseCsvCandidate(db, row);
  }
  log.info(
    { apply, candidates: rows.length, eligible, skipped, event: "csv_dedup_summary" },
    "CSV cross-source dedup backfill complete",
  );
  await db.$client.end({ timeout: 1 });
}

main().catch((err) => {
  log.error({ err, event: "csv_dedup_fatal" }, "CSV cross-source dedup backfill failed");
  process.exit(1);
});
