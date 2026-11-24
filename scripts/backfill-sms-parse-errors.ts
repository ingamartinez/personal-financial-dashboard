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
 *   AND its `*NNNN` resolves to an account this user registered
 *
 * Rows whose body still yields `needs_review` (a template nobody taught yet) or
 * `skip` (non-transactional — e.g. the card notices #1036 reclassifies) are
 * counted as not recoverable and left untouched: a skip is not money, and an
 * unreadable body must keep surfacing in the inbox (that is the error channel's
 * whole purpose). Only a successful insert resolves the row, mirroring
 * `retryIngestLog` in src/app/(app)/settings/inbox/actions.ts — `resolved_at`,
 * `resolved_txn_id` and `resolution = 'retried_success'`.
 *
 * #1039 — why the plan resolves accounts, and why every row is bounded
 * -------------------------------------------------------------------
 * The 2026-11-23 prod run planned 189 rows and hung for 7h36m. 173 of those
 * targeted cards the user has decided NOT to register (`*2091`, `*1235`,
 * `*3568`): `ingestParsed` can never route them, so they fail on every run
 * forever. They are a permanent loss by choice, and the plan now reports them
 * as `account_not_registered:<last4>` instead of planning them (spec S1).
 *
 * The remaining rows run under a per-row timeout (`--timeout-ms`, default 20s).
 * A row that exceeds it is recorded as `timeout:<ms>`, the loop moves on, and
 * the script exits non-zero — a stall becomes evidence instead of silence. The
 * timeout timer is unref'd, so it can never keep the process alive.
 *
 * Idempotency
 * -----------
 * A resolved row is out of the predicate, and the insert itself is guarded by
 * (account_id, external_id) uniqueness in `ingestParsed`. A second run therefore
 * inserts nothing and reports planned=0.
 *
 * CLI flags:
 *   --dry-run         Print the plan and write nothing.
 *   --user-id=N       Only consider user N (default: every user with rows).
 *   --limit=N         Attempt at most N planned rows in this run.
 *   --timeout-ms=N    Per-row timeout in milliseconds (default 20000).
 *
 * Usage:
 *   bun scripts/backfill-sms-parse-errors.ts --dry-run
 *   bun scripts/backfill-sms-parse-errors.ts --user-id=1 --dry-run
 *   bun scripts/backfill-sms-parse-errors.ts --user-id=1 --limit=20 --timeout-ms=20000
 *   bun scripts/backfill-sms-parse-errors.ts
 */

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../src/lib/db";
import { accounts, ingestionLogs, physicalCards } from "../src/lib/db/schema";
import { notDeleted } from "../src/lib/db/helpers";
import { parseSmsBancolombia, type ParsedSms } from "../src/lib/ingestion/sms-bancolombia";
import {
  resolveAccountFromLast4,
  type RoutableAccount,
} from "../src/lib/ingestion/bancolombia-variants";
import { ingestParsed, type IngestOutcome } from "../src/lib/ingestion/sms-pipeline";
import { createLogger } from "../src/lib/logger";

const log = createLogger({ module: "backfill-sms-parse-errors" });

/** S2: a row that takes longer than this is abandoned, not waited on. */
export const DEFAULT_ROW_TIMEOUT_MS = 20_000;

export type BackfillOptions = { userId?: number };

export type BackfillApplyOptions = BackfillOptions & {
  /** S4: attempt at most this many planned rows. */
  limit?: number;
  /** S2: per-row timeout, default `DEFAULT_ROW_TIMEOUT_MS`. */
  timeoutMs?: number;
};

/**
 * Test seam: the real `ingestParsed` unless a caller injects one. This is how
 * the stall in #1039 is reproduced in milliseconds instead of hours.
 */
export type BackfillDeps = {
  ingest?: (userId: number, parsed: ParsedSms) => Promise<IngestOutcome>;
};

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

/** Why an examined row will never be recovered by this script. */
export type BackfillNotRecoverable = {
  logId: number;
  userId: number;
  /**
   * `account_not_registered:<last4>` is permanent until the user registers the
   * card; `needs_review:<reason>` and `skip:<reason>` are parser verdicts;
   * `missing_body` means the log has no stored SMS text.
   */
  reason: string;
};

export type BackfillPlan = {
  /** Rows whose stored body now parses into a transaction — the plan. */
  rows: SmsParseErrorBackfillRow[];
  /** Unresolved error rows examined but not recoverable (unreadable, skip, unregistered card). */
  notRecoverable: number;
  /** The same rows, one entry per row, carrying the reason. */
  notRecoverableDetails: BackfillNotRecoverable[];
};

export type BackfillApplyReport = {
  /** Rows attempted in this run (bounded by `--limit`). */
  planned: number;
  inserted: number;
  failed: number;
  /** S5: non-zero for the process exit code when this is non-zero. */
  timedOut: number;
  /** Planned rows left unattempted because of `--limit`. */
  deferred: number;
  failures: { logId: number; reason: string }[];
};

export type BackfillCliResult = {
  exitCode: number;
  plan: BackfillPlan | null;
  /** Null on `--dry-run` — nothing was applied. */
  report: BackfillApplyReport | null;
};

type RoutableAccountRow = RoutableAccount & { institution: string; type: string };

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
 * The accounts `ingestParsed` will route this user's rows against: every live
 * account plus its parent physical card's last4, joined with the tenancy guard
 * so a corrupted FK can never leak another user's card into the plan (same
 * query shape as `ingestParsedBancolombia`).
 */
async function loadRoutableAccounts(userId: number): Promise<RoutableAccountRow[]> {
  const rows = await db
    .select({
      id: accounts.id,
      currency: accounts.currency,
      metadata: accounts.metadata,
      institution: accounts.institution,
      type: accounts.type,
      physicalCardLast4: physicalCards.last4,
    })
    .from(accounts)
    .leftJoin(
      physicalCards,
      and(eq(physicalCards.id, accounts.physicalCardId), eq(physicalCards.userId, accounts.userId)),
    )
    .where(and(eq(accounts.userId, userId), notDeleted(accounts.deletedAt)));
  return rows as RoutableAccountRow[];
}

/**
 * The `*NNNN` this kind routes by, in the order `ingestParsed` resolves them.
 * Kinds routed by institution instead (`provider_payment`,
 * `transfer_received_to_savings`) have no last4 and stay planned, unchanged.
 */
function routedLast4s(parsed: ParsedSms): string[] {
  switch (parsed.kind) {
    case "purchase":
      return [parsed.cardLast4];
    case "transfer_sent":
    case "qr_payment":
    case "provider_payment_sent":
    case "atm_withdrawal":
    case "bre_b_transfer":
      return [parsed.fromLast4];
    case "transfer_received":
      return [parsed.toLast4];
    case "tc_payment":
      return [parsed.fromLast4, parsed.toCardLast4];
    case "tc_credit_received":
      return [parsed.toCardLast4];
    case "cartera_tc":
      return [parsed.tcCardLast4];
    default:
      return [];
  }
}

/** First last4 that resolves to no account of this user, or null. */
function unresolvedLast4(parsed: ParsedSms, userAccounts: RoutableAccountRow[]): string | null {
  for (const last4 of routedLast4s(parsed)) {
    if (!resolveAccountFromLast4(last4, parsed.currency, userAccounts)) return last4;
  }
  return null;
}

/**
 * Read-only: which unresolved error logs would the backfill insert? Writes
 * nothing, so `--dry-run` can print it verbatim.
 */
export async function planSmsParseErrorBackfill(opts: BackfillOptions = {}): Promise<BackfillPlan> {
  const logs = await selectUnresolvedErrorSms(opts);
  const rows: SmsParseErrorBackfillRow[] = [];
  const notRecoverableDetails: BackfillNotRecoverable[] = [];
  const accountsByUser = new Map<number, RoutableAccountRow[]>();

  const mark = (entry: { id: number; userId: number }, reason: string): void => {
    notRecoverableDetails.push({ logId: entry.id, userId: entry.userId, reason });
  };

  for (const entry of logs) {
    const body = bodyFromPayload(entry.payload);
    if (!body) {
      mark(entry, "missing_body");
      continue;
    }
    const parsed = parseSmsBancolombia(body);
    // `skip` means "recognized, not money"; `needs_review` means "still
    // unreadable". Neither is a transaction to insert, and both stay visible in
    // the inbox because their log stays unresolved.
    if (parsed.kind === "needs_review" || parsed.kind === "skip") {
      mark(entry, `${parsed.kind}:${parsed.reason}`);
      continue;
    }
    // S1: an unregistered card can never route to an account, so the insert
    // would fail on every run forever. Plan it out instead of trying anyway.
    let userAccounts = accountsByUser.get(entry.userId);
    if (userAccounts === undefined) {
      userAccounts = await loadRoutableAccounts(entry.userId);
      accountsByUser.set(entry.userId, userAccounts);
    }
    const missingLast4 = unresolvedLast4(parsed, userAccounts);
    if (missingLast4 !== null) {
      mark(entry, `account_not_registered:${missingLast4}`);
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

  return { rows, notRecoverable: notRecoverableDetails.length, notRecoverableDetails };
}

class RowTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`timeout:${timeoutMs}`);
  }
}

/**
 * Race `work` against a timer. The timer is unref'd and cleared on settle so a
 * pending row timeout can never keep the process (or a Vitest worker) alive.
 */
async function runWithTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RowTimeoutError(timeoutMs)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Apply the plan: re-parse each stored body and ingest it through the same
 * `ingestParsed` the SMS route and the inbox retry use. Only a successful insert
 * resolves the log — a failure leaves it unresolved so the inbox still shows it.
 *
 * Every row is bounded by `timeoutMs` and emits exactly one progress line
 * carrying `index`/`total`, so a stall is visible in seconds (#1039).
 */
export async function applySmsParseErrorBackfill(
  opts: BackfillApplyOptions = {},
  deps: BackfillDeps = {},
): Promise<BackfillApplyReport> {
  const plan = await planSmsParseErrorBackfill(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ROW_TIMEOUT_MS;
  const ingest = deps.ingest ?? ingestParsed;
  const attempted = opts.limit === undefined ? plan.rows : plan.rows.slice(0, opts.limit);
  const report: BackfillApplyReport = {
    planned: attempted.length,
    inserted: 0,
    failed: 0,
    timedOut: 0,
    deferred: plan.rows.length - attempted.length,
    failures: [],
  };
  const total = attempted.length;

  for (const [position, row] of attempted.entries()) {
    const index = position + 1;
    const startedAt = Date.now();
    let outcome: IngestOutcome;
    try {
      outcome = await runWithTimeout(ingest(row.userId, row.parsed), timeoutMs);
    } catch (err) {
      if (!(err instanceof RowTimeoutError)) throw err;
      // S2/S3/S5: record it, keep going, and let the exit code say so.
      const reason = err.message;
      report.failed++;
      report.timedOut++;
      report.failures.push({ logId: row.logId, reason });
      log.warn(
        {
          event: "sms_parse_error_backfill_row",
          index,
          total,
          logId: row.logId,
          userId: row.userId,
          kind: row.kind,
          outcome: "timeout",
          reason,
          timeoutMs,
          durationMs: Date.now() - startedAt,
        },
        "row exceeded the per-row timeout — abandoned, loop continues",
      );
      continue;
    }

    if (outcome.status !== "inserted") {
      const reason =
        outcome.status === "duplicated"
          ? "duplicated: transaction already exists"
          : `${outcome.status}: ${outcome.reason}`;
      report.failed++;
      report.failures.push({ logId: row.logId, reason });
      log.warn(
        {
          event: "sms_parse_error_backfill_row",
          index,
          total,
          logId: row.logId,
          userId: row.userId,
          kind: row.kind,
          outcome: outcome.status,
          reason,
          durationMs: Date.now() - startedAt,
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
    log.info(
      {
        event: "sms_parse_error_backfill_row",
        index,
        total,
        logId: row.logId,
        userId: row.userId,
        kind: row.kind,
        outcome: "inserted",
        txId: outcome.txId,
        durationMs: Date.now() - startedAt,
      },
      "row ingested and its log resolved",
    );
  }

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

function parseArgs(argv: string[]): {
  dryRun: boolean;
  userId?: number;
  limit?: number;
  timeoutMs?: number;
} {
  let dryRun = false;
  let userId: number | undefined;
  let limit: number | undefined;
  let timeoutMs: number | undefined;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("--user-id=")) {
      userId = parsePositiveInt(arg, "--user-id");
      continue;
    }
    if (arg.startsWith("--limit=")) {
      limit = parsePositiveInt(arg, "--limit");
      continue;
    }
    if (arg.startsWith("--timeout-ms=")) {
      timeoutMs = parsePositiveInt(arg, "--timeout-ms");
      continue;
    }
    throw new CliUsageError(arg, "unknown argument");
  }

  return { dryRun, userId, limit, timeoutMs };
}

function countReasons(details: BackfillNotRecoverable[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const detail of details) counts[detail.reason] = (counts[detail.reason] ?? 0) + 1;
  return counts;
}

/**
 * The whole CLI in one callable unit: parse flags, plan, print, apply, and
 * decide the exit code. Returns instead of calling `process.exit` so tests can
 * observe the exit code without killing the runner.
 */
export async function runBackfillCli(
  argv: string[],
  deps: BackfillDeps = {},
): Promise<BackfillCliResult> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof CliUsageError)) throw err;
    log.error({ arg: err.arg, event: "sms_parse_error_backfill_bad_arg" }, err.message);
    return { exitCode: 1, plan: null, report: null };
  }

  const plan = await planSmsParseErrorBackfill({ userId: args.userId });

  log.info(
    {
      event: "sms_parse_error_backfill_plan",
      dryRun: args.dryRun,
      userId: args.userId ?? null,
      limit: args.limit ?? null,
      timeoutMs: args.timeoutMs ?? DEFAULT_ROW_TIMEOUT_MS,
      count: plan.rows.length,
      notRecoverable: plan.notRecoverable,
      // #1039/S13: a dry run must say WHY nothing can be recovered — e.g.
      // `{"account_not_registered:2091": 113}` for the cards left unregistered.
      notRecoverableByReason: countReasons(plan.notRecoverableDetails),
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
    args.dryRun ? "dry run — no writes" : "applying SMS parse-error backfill",
  );
  if (args.dryRun) return { exitCode: 0, plan, report: null };

  const report = await applySmsParseErrorBackfill(
    { userId: args.userId, limit: args.limit, timeoutMs: args.timeoutMs },
    deps,
  );
  log.info(
    { event: "sms_parse_error_backfill_done", userId: args.userId ?? null, ...report },
    "SMS parse-error backfill complete",
  );

  // S5: a stall cannot be mistaken for success.
  return { exitCode: report.timedOut > 0 ? 1 : 0, plan, report };
}

async function main(): Promise<void> {
  const { exitCode } = await runBackfillCli(process.argv.slice(2));
  process.exitCode = exitCode;
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    log.error({ err, event: "sms_parse_error_backfill_failed" }, "SMS parse-error backfill failed");
    process.exit(1);
  });
}
