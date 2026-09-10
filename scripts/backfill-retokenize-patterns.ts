/**
 * #852: Rebuild recurring_description_patterns from description_raw.
 *
 * Stored pattern text cannot be re-tokenized — tokeniseDescription("PAGO") is
 * null after the verb skip. This script re-derives tokens from observation
 * and linked-tx descriptions, sets observationCount to distinct tx ids
 * (never summed old counts), and on a real change re-runs auto-link so
 * orphans like tx 2652 can take the unique-token path.
 *
 * Idempotent: a second run writes nothing; relink still runs so a crash
 * mid-auto-link can recover.
 *
 * Usage:
 *   bun scripts/backfill-retokenize-patterns.ts --dry-run
 *   bun scripts/backfill-retokenize-patterns.ts --user-id=1 --dry-run
 *   bun scripts/backfill-retokenize-patterns.ts
 *   bun scripts/backfill-retokenize-patterns.ts --no-relink
 *
 * Relative imports on purpose — overlay-safe on prod deploys.
 */

import { createLogger } from "../src/lib/logger";
import { rebuildDescriptionPatterns } from "../src/lib/recurring/rebuild-description-patterns";

const log = createLogger({ module: "backfill-retokenize-patterns" });

function parseArgs(argv: string[]): { dryRun: boolean; relink: boolean; userId?: number } {
  let dryRun = false;
  let relink = true;
  let userId: number | undefined;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--no-relink") relink = false;
    else if (arg.startsWith("--user-id=")) {
      const n = Number(arg.slice("--user-id=".length));
      if (!Number.isInteger(n) || n <= 0) {
        log.error({ arg, event: "backfill_retokenize_bad_user" }, "invalid --user-id");
        process.exit(1);
      }
      userId = n;
    } else if (arg === "--user-id") {
      log.error({ event: "backfill_retokenize_bad_user" }, "use --user-id=N");
      process.exit(1);
    } else {
      log.warn({ arg, event: "backfill_retokenize_unknown_arg" }, "unknown flag — ignored");
    }
  }
  return { dryRun, relink, userId };
}

async function main() {
  const { dryRun, relink, userId } = parseArgs(process.argv.slice(2));
  log.info(
    { dryRun, relink, userId: userId ?? null, event: "backfill_retokenize_start" },
    "starting description-pattern rebuild",
  );
  const report = await rebuildDescriptionPatterns({
    dryRun,
    relink: dryRun ? false : relink,
    userId,
  });
  log.info(
    { ...report, event: "backfill_retokenize_done" },
    report.dryRun
      ? "DRY RUN complete — no writes"
      : report.changed
        ? "rebuild complete"
        : "already up to date (idempotent re-run)",
  );
}

main().catch((err: unknown) => {
  log.error({ err, event: "backfill_retokenize_fatal" }, "backfill-retokenize-patterns failed");
  process.exit(1);
});
