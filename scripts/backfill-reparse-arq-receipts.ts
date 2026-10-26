/**
 * One-shot backfill (#1015): reparse ARQ receipts the parser could not read
 * when they arrived, now that the "COP payment received" template is handled.
 *
 * Stuck ARQ receipts sit as match_status='unmatched' with
 * parsed_payload.error.reason recorded (markReceiptNeedsReview). The 5-minute
 * gmail-pull cron only picks up 'pending', so extending the parser does not by
 * itself recover them — this script does, deliberately and per receipt.
 *
 * Only receipts the current parser returns `parsed` for are re-ingested, through
 * the same ingestion path the cron uses. Marketing/notification mail keeps its
 * recorded skip/review state; nothing is guessed.
 *
 * CLI flags:
 *   --dry-run       Print what each stuck receipt would become. Writes nothing.
 *   --user-id=N     Only process user N (default: every user with receipts).
 *   --help          Print this header.
 *
 * Usage:
 *   bun scripts/backfill-reparse-arq-receipts.ts --dry-run
 *   bun scripts/backfill-reparse-arq-receipts --user-id=1 --dry-run
 *   bun scripts/backfill-reparse-arq-receipts --user-id=1
 *
 * Manual one-off: NOT wired into deploy.yml. On prod, run it from the release
 * directory after sourcing /srv/findash/env/findash.env (systemd loads it via
 * EnvironmentFile; a bare shell does not).
 */

import { createLogger } from "../src/lib/logger";
import { planArqReparse, reparseArqReceipts } from "../src/lib/gmail/reparse-arq";

const log = createLogger({ module: "backfill-reparse-arq-receipts" });

const args = process.argv.slice(2);

if (args.includes("--help")) {
  const header = process.argv[1];
  log.info({ script: header }, "see the header comment of this script for usage");
  process.exit(0);
}

const DRY_RUN = args.includes("--dry-run");
const USER_ID_ARG = args.find((arg) => arg.startsWith("--user-id="));
const userId: number | undefined = USER_ID_ARG ? Number(USER_ID_ARG.split("=")[1]) : undefined;

if (USER_ID_ARG !== undefined && (!Number.isFinite(userId) || (userId ?? 0) <= 0)) {
  log.error({ userIdArg: USER_ID_ARG }, "--user-id must be a positive integer");
  process.exit(1);
}

const unknownFlags = args.filter(
  (arg) => arg !== "--dry-run" && arg !== "--help" && !arg.startsWith("--user-id="),
);
if (unknownFlags.length > 0) {
  log.error({ unknownFlags }, "unknown flags — refusing to run");
  process.exit(1);
}

const plan = await planArqReparse({ userId });

for (const candidate of plan.candidates) {
  log.info(
    {
      dryRun: DRY_RUN,
      receiptId: candidate.receiptId,
      userId: candidate.userId,
      emailReceivedAt: candidate.emailReceivedAt?.toISOString() ?? null,
      outcome: candidate.outcome,
      reason: candidate.reason,
      amountUsdcCents: candidate.amountUsdcCents,
      counterpartyName: candidate.counterpartyName,
      copAmountCents: candidate.copAmountCents,
      impliedTrmCopPerUsdc: candidate.impliedTrmCopPerUsdc,
      event: "arq_reparse_candidate",
    },
    candidate.outcome === "parsed"
      ? "would become a transaction"
      : "still not parseable; left untouched",
  );
}

if (DRY_RUN) {
  log.info(
    {
      dryRun: true,
      userId: userId ?? null,
      considered: plan.candidates.length,
      parsed: plan.parsed,
      stillUnparsed: plan.stillUnparsed,
      event: "arq_reparse_dry_run_done",
    },
    "dry run complete — no writes performed",
  );
  process.exit(0);
}

const report = await reparseArqReceipts({ userId });

log.info(
  { ...report, userId: userId ?? null, event: "arq_reparse_backfill_done" },
  "reparsed ARQ receipts",
);

// A receipt that parses but cannot be ingested (e.g. no ARQ account) must not
// be reported as success: exit non-zero so an operator sees it.
process.exit(report.failed > 0 ? 1 : 0);
