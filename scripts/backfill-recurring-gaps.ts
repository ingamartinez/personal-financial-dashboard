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

type Args = { from: string; to: string };

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from") args.from = argv[++i];
    else if (argv[i] === "--to") args.to = argv[++i];
  }
  if (!args.from || !args.to) {
    console.error("Usage: bun run scripts/backfill-recurring-gaps.ts --from YYYY-MM --to YYYY-MM");
    process.exit(1);
  }
  if (!/^\d{4}-\d{2}$/.test(args.from) || !/^\d{4}-\d{2}$/.test(args.to)) {
    console.error("--from and --to must match YYYY-MM");
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
  console.log(`Backfilling ${months.length} month(s): ${from} → ${to}`);

  let totalGapsCreated = 0;
  let totalAutoLinked = 0;
  for (const ym of months) {
    const result = await detectGapsForMonth(ym);
    totalGapsCreated += result.gapsCreated;
    totalAutoLinked += result.autoLinked;
    console.log(`  ${ym}: ${JSON.stringify(result)}`);
  }

  console.log(`Done. ${totalGapsCreated} new gaps, ${totalAutoLinked} auto-linked.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
