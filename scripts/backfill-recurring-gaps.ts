#!/usr/bin/env bun
/**
 * Opt-in backfill for recurring_gaps across past months.
 *
 * Usage:
 *   bun run scripts/backfill-recurring-gaps.ts --from 2025-10 --to 2026-03
 *
 * Idempotent: re-running is a no-op for months that were already reconciled.
 * Auto-links any unlinked tx matching the amount+account+window of a recurring
 * before creating a gap. Months with no unresolved recurrings produce no rows.
 */

import { detectGapsForMonth } from "@/lib/recurring/gap-detector";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "backfill-recurring-gaps" });

type Args = { from: string; to: string };

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from") args.from = argv[++i];
    else if (argv[i] === "--to") args.to = argv[++i];
  }
  if (!args.from || !args.to) {
    log.error(
      { event: "backfill_gaps_usage" },
      "Usage: bun run scripts/backfill-recurring-gaps.ts --from YYYY-MM --to YYYY-MM",
    );
    process.exit(1);
  }
  if (!/^\d{4}-\d{2}$/.test(args.from) || !/^\d{4}-\d{2}$/.test(args.to)) {
    log.error({ event: "backfill_gaps_invalid_format" }, "--from and --to must match YYYY-MM");
    process.exit(1);
  }
  return args as Args;
}

function monthsBetween(from: string, to: string): string[] {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  const out: string[] = [];
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); ) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

async function main() {
  const { from, to } = parseArgs(process.argv.slice(2));
  const months = monthsBetween(from, to);
  log.info({ count: months.length, from, to, event: "backfill_gaps_start" }, "Backfilling months");

  let totalGapsCreated = 0;
  let totalAutoLinked = 0;
  for (const ym of months) {
    // Backfill script runs against the single-user dev DB pre-multi-tenancy
    // data, so user_id=1 is the right scope.
    const result = await detectGapsForMonth(1, ym);
    totalGapsCreated += result.gapsCreated;
    totalAutoLinked += result.autoLinked;
    log.info({ ym, result, event: "backfill_gaps_month_done" }, "month processed");
  }

  log.info(
    { totalGapsCreated, totalAutoLinked, event: "backfill_gaps_done" },
    "Done backfilling gaps",
  );
  process.exit(0);
}

main().catch((err) => {
  log.error({ err, event: "backfill_gaps_failed" }, "backfill-recurring-gaps failed");
  process.exit(1);
});
