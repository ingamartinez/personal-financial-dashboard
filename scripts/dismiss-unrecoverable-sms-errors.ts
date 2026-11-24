/**
 * One-shot dismissal (#1042) of the SMS parse errors that can never be
 * recovered, reusing the classification the backfill already computes (#1036,
 * #1039).
 *
 * Why a dismissal and not a retry
 * -------------------------------
 * The inbox holds three kinds of unresolved SMS error, and mixing them is what
 * made the error channel unreadable:
 *
 *   `account_not_registered:<last4>`  permanent loss by the user's explicit
 *                                     decision — `ingestParsed` can never route
 *                                     it, so it fails on every retry forever
 *   `skip:non_transactional`          recognised, not money (card on/off
 *                                     notices, #1036)
 *   `needs_review:<reason>`           still unreadable — the only signal the
 *                                     next unparseable-template defect has
 *
 * The first two are dismissed; `needs_review:*` is NEVER dismissed (S3). A
 * dismissal sets `resolution='dismissed'` and `resolved_at=now()` and nothing
 * else — the same surface `dismissIngestLog` writes in the inbox actions (S2).
 * No transaction is created: a skip is not money and an unregistered card is
 * money the user chose not to track.
 *
 * Candidate predicate (S1)
 * ------------------------
 *   source = 'sms' AND status = 'error' AND resolved_at IS NULL
 *
 * The classification is NOT re-implemented (S6): `planSmsParseErrorBackfill`
 * already parses each stored body and resolves its `*NNNN` against that user's
 * accounts, and it reports the reason per row in `notRecoverableDetails`. Two
 * copies of the account-resolution rule would drift, and a drifting rule is
 * what produced #1036.
 *
 * Idempotency (S5)
 * ----------------
 * A dismissed row drops out of the predicate, and the UPDATE itself re-asserts
 * the predicate, so a second apply dismisses zero.
 *
 * CLI flags:
 *   --dry-run         Print the plan and write nothing (S4).
 *   --user-id=N       Only consider user N (default: every user with rows).
 *
 * Usage:
 *   bun scripts/dismiss-unrecoverable-sms-errors.ts --dry-run
 *   bun scripts/dismiss-unrecoverable-sms-errors.ts --user-id=1 --dry-run
 *   bun scripts/dismiss-unrecoverable-sms-errors.ts
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../src/lib/db";
import { ingestionLogs } from "../src/lib/db/schema";
import { createLogger } from "../src/lib/logger";
import {
  planSmsParseErrorBackfill,
  type BackfillNotRecoverable,
} from "./backfill-sms-parse-errors";

const log = createLogger({ module: "dismiss-unrecoverable-sms-errors" });

/** S2: the inbox's own dismissal value — see `dismissIngestLog`. */
export const DISMISSED_RESOLUTION = "dismissed";

/** Reasons that are permanent until the user registers the card. */
const UNREGISTERED_CARD_PREFIX = "account_not_registered:";
/** The card-notice class #1036 taught the parser to recognise. */
const NON_TRANSACTIONAL_REASON = "skip:non_transactional";
/** Bucket for rows the backfill can still insert — never dismissed here. */
const RECOVERABLE_REASON = "recoverable";

export type DismissOptions = { userId?: number };

/** One row this script will dismiss, with the computed reason. */
export type DismissRow = { logId: number; userId: number; reason: string };

export type DismissPlan = {
  /** S1: the rows that qualify for dismissal, one entry per row. */
  rows: DismissRow[];
  /** S4: how many rows carry each dismissable reason. */
  countsByReason: Record<string, number>;
  /** S4: candidate rows this run leaves unresolved. */
  leftOpen: number;
  /** S4: the same rows, grouped by why they stay open. */
  leftOpenByReason: Record<string, number>;
};

export type DismissApplyReport = {
  /** Rows actually transitioned to `resolution='dismissed'` in this run. */
  dismissed: number;
  /** Candidate rows still unresolved when the run finished. */
  leftOpen: number;
};

export type DismissCliResult = {
  exitCode: number;
  /** Null only when the arguments were rejected. */
  plan: DismissPlan | null;
  /** Null on `--dry-run` — nothing was applied. */
  report: DismissApplyReport | null;
};

/**
 * S1/S3: the only two reason shapes this script may dismiss. Everything else
 * — `needs_review:*`, `missing_body`, any other skip reason — stays open so the
 * inbox keeps reporting it.
 */
export function isDismissableSmsReason(reason: string): boolean {
  return reason.startsWith(UNREGISTERED_CARD_PREFIX) || reason === NON_TRANSACTIONAL_REASON;
}

function countReasons(details: BackfillNotRecoverable[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const detail of details) counts[detail.reason] = (counts[detail.reason] ?? 0) + 1;
  return counts;
}

/**
 * Read-only: which unresolved SMS error rows are permanently unrecoverable and
 * why. Writes nothing, so `--dry-run` can print it verbatim (S4).
 */
export async function planUnrecoverableSmsDismissal(
  opts: DismissOptions = {},
): Promise<DismissPlan> {
  const backfillPlan = await planSmsParseErrorBackfill({ userId: opts.userId });

  const dismissable = backfillPlan.notRecoverableDetails.filter((detail) =>
    isDismissableSmsReason(detail.reason),
  );
  const stayingOpen = backfillPlan.notRecoverableDetails.filter(
    (detail) => !isDismissableSmsReason(detail.reason),
  );

  const leftOpenByReason = countReasons(stayingOpen);
  // A row the backfill can still insert is not this script's business, but it
  // is still an open error row, so S4's "left open" must count it.
  if (backfillPlan.rows.length > 0) {
    leftOpenByReason[RECOVERABLE_REASON] = backfillPlan.rows.length;
  }

  return {
    rows: dismissable.map((detail) => ({
      logId: detail.logId,
      userId: detail.userId,
      reason: detail.reason,
    })),
    countsByReason: countReasons(dismissable),
    leftOpen: stayingOpen.length + backfillPlan.rows.length,
    leftOpenByReason,
  };
}

/**
 * Apply the plan: one guarded UPDATE sets `resolution='dismissed'` and
 * `resolved_at` on the dismissable rows and touches nothing else (S2).
 *
 * The predicate is re-asserted in the UPDATE, so a row resolved between the plan
 * and the write is left alone and a second run dismisses zero (S5).
 */
export async function applyUnrecoverableSmsDismissal(
  opts: DismissOptions = {},
): Promise<DismissApplyReport> {
  const plan = await planUnrecoverableSmsDismissal(opts);
  if (plan.rows.length === 0) return { dismissed: 0, leftOpen: plan.leftOpen };

  const updated = await db
    .update(ingestionLogs)
    .set({ resolvedAt: new Date(), resolution: DISMISSED_RESOLUTION })
    .where(
      and(
        inArray(
          ingestionLogs.id,
          plan.rows.map((row) => row.logId),
        ),
        eq(ingestionLogs.source, "sms"),
        eq(ingestionLogs.status, "error"),
        isNull(ingestionLogs.resolvedAt),
      ),
    )
    .returning({ id: ingestionLogs.id, userId: ingestionLogs.userId });

  // A planned row that the UPDATE skipped (someone else resolved it meanwhile)
  // stays open, so it must not vanish from the reported count.
  const report: DismissApplyReport = {
    dismissed: updated.length,
    leftOpen: plan.leftOpen + (plan.rows.length - updated.length),
  };

  log.info(
    {
      event: "sms_dismiss_done",
      userId: opts.userId ?? null,
      planned: plan.rows.length,
      ...report,
    },
    "permanently-unrecoverable SMS parse errors dismissed",
  );
  return report;
}

class CliUsageError extends Error {
  constructor(
    readonly arg: string,
    message: string,
  ) {
    super(message);
  }
}

function parsePositiveInt(arg: string, name: string): number {
  const value = Number(arg.slice(name.length + 1));
  if (!Number.isInteger(value) || value <= 0) {
    throw new CliUsageError(arg, `${name} must be a positive integer`);
  }
  return value;
}

function parseArgs(argv: string[]): { dryRun: boolean; userId?: number } {
  let dryRun = false;
  let userId: number | undefined;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("--user-id=")) {
      userId = parsePositiveInt(arg, "--user-id");
      continue;
    }
    throw new CliUsageError(arg, "unknown argument");
  }

  return { dryRun, userId };
}

/**
 * The whole CLI in one callable unit: parse flags, plan, print, apply. Returns
 * instead of calling `process.exit` so tests can observe the outcome without
 * killing the runner.
 */
export async function runDismissCli(argv: string[]): Promise<DismissCliResult> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof CliUsageError)) throw err;
    log.error({ arg: err.arg, event: "sms_dismiss_bad_arg" }, err.message);
    return { exitCode: 1, plan: null, report: null };
  }

  const plan = await planUnrecoverableSmsDismissal({ userId: args.userId });

  log.info(
    {
      event: "sms_dismiss_plan",
      dryRun: args.dryRun,
      userId: args.userId ?? null,
      dismissable: plan.rows.length,
      countsByReason: plan.countsByReason,
      leftOpen: plan.leftOpen,
      leftOpenByReason: plan.leftOpenByReason,
      logIds: plan.rows.map((row) => row.logId),
    },
    args.dryRun ? "dry run — no writes" : "applying SMS parse-error dismissal",
  );
  if (args.dryRun) return { exitCode: 0, plan, report: null };

  const report = await applyUnrecoverableSmsDismissal({ userId: args.userId });
  return { exitCode: 0, plan, report };
}

async function main(): Promise<void> {
  const { exitCode } = await runDismissCli(process.argv.slice(2));
  process.exitCode = exitCode;
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    log.error({ err, event: "sms_dismiss_failed" }, "SMS parse-error dismissal failed");
    process.exit(1);
  });
}
