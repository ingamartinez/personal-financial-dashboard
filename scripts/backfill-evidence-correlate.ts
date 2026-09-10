/**
 * One-shot backfill (#863): correlate unmatched amount-less evidence
 * receipts to a unique in-window transaction. Provenance only — does not
 * reclassify, overwrite merchant, or change method/confidence.
 *
 * Reachable on prod since #848/#850: scripts/ and src/ are overlaid
 * whole-tree and the release gets a real lockfile install. This script
 * talks to Postgres only (peer auth via the socket). It does not import
 * Gmail, Telegram, or the Anthropic client, so it does not need those
 * app secrets. If PGDATABASE / PGHOST are not the process defaults,
 * source the systemd env file first so you hit prod and not a local DB.
 *
 * NOT wired into deploy.yml's automatic step list — run by hand.
 *
 * Idempotent: already-matched rows are outside the WHERE. Re-running
 * after the first pass considers 0 remaining unique matches.
 *
 * CLI flags:
 *   --dry-run       Print how many rows would be considered, write nothing.
 *   --user-id=N     Only process user N (default: every user with rows).
 *
 * Usage:
 *   bun scripts/backfill-evidence-correlate.ts --dry-run
 *   bun scripts/backfill-evidence-correlate.ts --user-id=1 --dry-run
 *   bun scripts/backfill-evidence-correlate.ts
 */

import { createLogger } from "../src/lib/logger";
import {
  backfillUnmatchedEvidenceReceipts,
  countUnmatchedEvidenceReceipts,
} from "../src/lib/correlation/link-evidence";

const log = createLogger({ module: "backfill-evidence-correlate" });

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const USER_ID_ARG = args.find((a) => a.startsWith("--user-id="));
const userId: number | undefined = USER_ID_ARG ? Number(USER_ID_ARG.split("=")[1]) : undefined;

if (userId !== undefined && (!Number.isFinite(userId) || userId <= 0)) {
  log.error({ userIdArg: USER_ID_ARG }, "--user-id must be a positive integer");
  process.exit(1);
}

const count = await countUnmatchedEvidenceReceipts({ userId });
if (DRY_RUN) {
  log.info(
    { count, userId: userId ?? null, dryRun: true, event: "evidence_link_dry_run" },
    "would correlate unmatched evidence receipts",
  );
  process.exit(0);
}

const report = await backfillUnmatchedEvidenceReceipts({ userId });
log.info(
  { ...report, userId: userId ?? null, event: "evidence_link_backfill_done" },
  "correlated unmatched evidence receipts",
);
process.exit(0);
