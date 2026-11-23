/**
 * One-shot backfill (#1036): recover the SMS that were dropped as
 * `unknown_pattern` before the Bre-B/llave templates learned `@`-prefixed keys.
 *
 * Why this is a re-parse, not a re-ingest from the phone
 * -----------------------------------------------------
 * The raw body of every SMS is already stored in `ingestion_logs.payload.body`
 * (see POST /api/ingest/sms). A parser fix therefore does not need the phone,
 * the sender, or a retyped amount: parse the stored body again and hand the
 * result to the same `ingestParsed` the inbox retry uses. This script is that
 * loop, without a human picking an account for each row.
 *
 * Candidate predicate (tenant-safe, nothing enumerated)
 * ----------------------------------------------------
 *   source = 'sms'
 *   AND status = 'error'
 *   AND resolved_at IS NULL            -- the inbox's own "unresolved" definition
 *   AND payload.body reparses into a transaction
 *
 * Rows whose body still yields `needs_review` (a template nobody taught yet) or
 * `skip` (non-transactional — e.g. the card notices #1036 reclassifies) are
 * counted as not recoverable and left untouched: a skip is not money, and an
 * unreadable body must keep surfacing in the inbox (that is the error channel's
 * whole purpose). Only a successful insert resolves the row, mirroring
 * `retryIngestLog` in src/app/(app)/settings/inbox/actions.ts — `resolved_at`,
 * `resolved_txn_id` and `resolution = 'retried_success'`.
 *
 * Idempotency
 * -----------
 * A resolved row is out of the predicate, and the insert itself is guarded by
 * (account_id, external_id) uniqueness in `ingestParsed`. A second run therefore
 * inserts nothing and reports planned=0.
 *
 * CLI flags:
 *   --dry-run       Print the plan and write nothing.
 *   --user-id=N     Only consider user N (default: every user with rows).
 *
 * Usage:
 *   bun scripts/backfill-sms-parse-errors.ts --dry-run
 *   bun scripts/backfill-sms-parse-errors.ts --user-id=1 --dry-run
 *   bun scripts/backfill-sms-parse-errors.ts
 */

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../src/lib/db";
import { ingestionLogs } from "../src/lib/db/schema";
import { parseSmsBancolombia, type ParsedSms } from "../src/lib/ingestion/sms-bancolombia";
import { ingestParsed } from "../src/lib/ingestion/sms-pipeline";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "backfill-sms-parse-errors" });

export type BackfillOptions = { userId?: number };

/** One stored log that now parses, with the fields a dry run must show. */
export type SmsParseErrorBackfillRow = {
  logId: number;
  userId: number;
  kind: ParsedSms["kind"];
  /** String on purpose: BigInt must never reach a Pino field. */
  amountCents: string;
  currency: string;
  occurredOn: string | null;
  occurredTime: string | null;
  body: string;
  parsed: ParsedSms;
};

export type BackfillPlan = {
  /** Rows whose stored body now parses into a transaction — the plan. */
  rows: SmsParseErrorBackfillRow[];
  /** Unresolved error rows examined but not recoverable (still unreadable, or a skip). */
  notRecoverable: number;
};

export type BackfillApplyReport = {
  planned: number;
  inserted: number;
  failed: number;
  failures: { logId: number; reason: string }[];
};

function bodyFromPayload(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const body = (payload as { body?: unknown }).body;
  return typeof body === "string" && body.trim() !== "" ? body : null;
}

async function selectUnresolvedErrorSms(
  opts: BackfillOptions,
): Promise<{ id: number; userId: number; payload: unknown }[]> {
  return db
    .select({ id: ingestionLogs.id, userId: ingestionLogs.userId, payload: ingestionLogs.payload })
    .from(ingestionLogs)
    .where(
      and(
        eq(ingestionLogs.source, "sms"),
        eq(ingestionLogs.status, "error"),
        isNull(ingestionLogs.resolvedAt),
        opts.userId === undefined ? undefined : eq(ingestionLogs.userId, opts.userId),
      ),
    )
    .orderBy(ingestionLogs.id);
}

/**
 * Read-only: which unresolved error logs would the backfill insert? Writes
 * nothing, so `--dry-run` can print it verbatim.
 */
export async function planSmsParseErrorBackfill(opts: BackfillOptions = {}): Promise<BackfillPlan> {
  const logs = await selectUnresolvedErrorSms(opts);
  const rows: SmsParseErrorBackfillRow[] = [];
  let notRecoverable = 0;

  for (const entry of logs) {
    const body = bodyFromPayload(entry.payload);
    if (!body) {
      notRecoverable++;
      continue;
    }
    const parsed = parseSmsBancolombia(body);
    // `skip` means "recognized, not money"; `needs_review` means "still
    // unreadable". Neither is a transaction to insert, and both stay visible in
    // the inbox because their log stays unresolved.
    if (parsed.kind === "needs_review" || parsed.kind === "skip") {
      notRecoverable++;
      continue;
    }
    rows.push({
      logId: entry.id,
      userId: entry.userId,
      kind: parsed.kind,
      amountCents: parsed.amountCents.toString(),
      currency: parsed.currency,
      occurredOn: "occurredOn" in parsed ? parsed.occurredOn : null,
      occurredTime: "occurredTime" in parsed ? parsed.occurredTime : null,
      body,
      parsed,
    });
  }

  return { rows, notRecoverable };
}

/**
 * Apply the plan: re-parse each stored body and ingest it through the same
 * `ingestParsed` the SMS route and the inbox retry use. Only a successful insert
 * resolves the log — a failure leaves it unresolved so the inbox still shows it.
 */
export async function applySmsParseErrorBackfill(
  opts: BackfillOptions = {},
): Promise<BackfillApplyReport> {
  const plan = await planSmsParseErrorBackfill(opts);
  const report: BackfillApplyReport = {
    planned: plan.rows.length,
    inserted: 0,
    failed: 0,
    failures: [],
  };

  for (const row of plan.rows) {
    const outcome = await ingestParsed(row.userId, row.parsed);

    if (outcome.status !== "inserted") {
      const reason =
        outcome.status === "duplicated"
          ? "duplicated: transaction already exists"
          : `${outcome.status}: ${outcome.reason}`;
      report.failed++;
      report.failures.push({ logId: row.logId, reason });
      log.warn(
        {
          event: "sms_parse_error_backfill_row_failed",
          logId: row.logId,
          userId: row.userId,
          kind: row.kind,
          status: outcome.status,
          reason,
        },
        "backfill could not insert this row — leaving it unresolved for the inbox",
      );
      continue;
    }

    await db
      .update(ingestionLogs)
      .set({
        resolvedAt: new Date(),
        resolvedTxnId: outcome.txId,
        resolution: "retried_success",
      })
      .where(and(eq(ingestionLogs.id, row.logId), isNull(ingestionLogs.resolvedAt)));
    report.inserted++;
  }

  return report;
}

function parseArgs(argv: string[]): { dryRun: boolean; userId: number | undefined } {
  let dryRun = false;
  let userId: number | undefined;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("--user-id=")) {
      userId = Number(arg.slice("--user-id=".length));
      if (!Number.isInteger(userId) || userId <= 0) {
        log.error(
          { arg, event: "sms_parse_error_backfill_bad_arg" },
          "--user-id must be a positive integer",
        );
        process.exit(1);
      }
      continue;
    }
    log.error({ arg, event: "sms_parse_error_backfill_unknown_arg" }, "unknown argument");
    process.exit(1);
  }

  return { dryRun, userId };
}

async function main(): Promise<void> {
  const { dryRun, userId } = parseArgs(process.argv.slice(2));
  const plan = await planSmsParseErrorBackfill({ userId });

  log.info(
    {
      event: "sms_parse_error_backfill_plan",
      dryRun,
      userId: userId ?? null,
      count: plan.rows.length,
      notRecoverable: plan.notRecoverable,
      // Trimmed body keeps the log readable; the full text stays in the row.
      rows: plan.rows.map((row) => ({
        logId: row.logId,
        userId: row.userId,
        kind: row.kind,
        amountCents: row.amountCents,
        currency: row.currency,
        occurredOn: row.occurredOn,
        occurredTime: row.occurredTime,
        body: row.body.slice(0, 160),
      })),
    },
    dryRun ? "dry run — no writes" : "applying SMS parse-error backfill",
  );
  if (dryRun) return;

  const report = await applySmsParseErrorBackfill({ userId });
  log.info(
    { event: "sms_parse_error_backfill_done", userId: userId ?? null, ...report },
    "SMS parse-error backfill complete",
  );
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    log.error({ err, event: "sms_parse_error_backfill_failed" }, "SMS parse-error backfill failed");
    process.exit(1);
  });
}
