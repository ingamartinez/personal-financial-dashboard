import type { gmail_v1 } from "googleapis";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailReceipts } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import {
  getAuthedClient,
  isInvalidGrantError,
  markConnectionUnusable,
  GmailConnectionUnusableError,
  GmailNotConnectedError,
  type AuthedGmailClient,
} from "@/lib/gmail/client";
import { buildSenderQuery, getGatewayById } from "@/lib/gmail/registry";
import { parseBancolombiaEmail } from "@/lib/gmail/parsers/bancolombia";
import { ingestParsedEmail } from "@/lib/ingestion/email-bancolombia";

const log = createLogger({ module: "gmail/backfill" });

// Gmail read quota is 250 units/user/second; `list` and `get` each cost 5
// units, so 20 msgs/sec leaves headroom for retries and bursty traffic. With
// ~500 msgs/year the full-year backfill takes ~25 s, safely under Telegram's
// ~60 s webhook budget.
const DEFAULT_SLEEP_BETWEEN_GETS_MS = 50;

// How often to invoke the progress callback during the fetch+ingest loop.
const DEFAULT_PROGRESS_STRIDE = 100;

// Retry budget for transient (429 / 5xx) errors on individual Gmail calls.
// Lower than the pull engine's because backfill loops are longer — we'd
// rather surface an error and keep going than chain waits into minutes.
const MAX_RETRIES = 3;

export interface BackfillErrorDetail {
  phase: "auth" | "list" | "get" | "persist" | "ingest";
  messageId?: string;
  code?: string;
  message: string;
}

export interface BackfillReport {
  totalEmails: number;
  alreadyStored: number;
  parsed: number;
  skipped: number;
  needsReview: number;
  inserted: number;
  matchedExisting: number;
  sourceMismatches: number;
  errors: BackfillErrorDetail[];
  durationMs: number;
  canceled: boolean;
}

export interface BackfillDryRunReport {
  totalEmails: number;
  alreadyStored: number;
  newEmails: number;
  durationMs: number;
}

export interface BackfillOpts {
  from: Date;
  to: Date;
  // Fires every `progressStride` messages processed during the ingest phase
  // (post-list). Also fires once at phase transitions so the caller can show
  // the user "listing... 318 found. fetching...". Not awaited — the caller
  // controls whether it blocks.
  onProgress?: (progress: {
    phase: "listing" | "fetching" | "done";
    processed: number;
    total: number;
  }) => void | Promise<void>;
  // Polled between every message fetch. Returning true aborts cleanly and
  // `report.canceled` is set. Partial results are preserved.
  shouldCancel?: () => boolean | Promise<boolean>;
  // Override for tests. The default is `DEFAULT_PROGRESS_STRIDE`.
  progressStride?: number;
}

export interface BackfillDeps {
  getClient?: (userId: number) => Promise<AuthedGmailClient>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export class BackfillConnectionError extends Error {
  constructor(
    message: string,
    readonly reason: "not_connected" | "revoked" | "unusable",
  ) {
    super(message);
    this.name = "BackfillConnectionError";
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Gmail accepts yyyy/mm/dd for `after:` / `before:`. `before:` is EXCLUSIVE
// at midnight UTC, so callers who want "through day X inclusive" should pass
// day X+1 as `to`.
function toGmailDateQuery(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

function getHttpStatus(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { code?: number | string; status?: number; response?: { status?: number } };
  if (typeof e.code === "number") return e.code;
  if (typeof e.status === "number") return e.status;
  if (typeof e.response?.status === "number") return e.response.status;
  return null;
}

function getRetryAfterSeconds(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const headers = (err as { response?: { headers?: Record<string, unknown> } }).response?.headers;
  const raw = headers?.["retry-after"];
  if (typeof raw !== "string") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  deps: { sleep: (ms: number) => Promise<void> },
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = getHttpStatus(err);
      const isRetryable = status === 429 || (status !== null && status >= 500);
      if (!isRetryable) throw err;
      const retryAfter = getRetryAfterSeconds(err);
      const delayMs = retryAfter ? retryAfter * 1000 : 500 * Math.pow(2, attempt);
      await deps.sleep(delayMs);
    }
  }
  throw lastErr;
}

function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";
  const html = findByMimeType(payload, "text/html");
  if (html) return html;
  const plain = findByMimeType(payload, "text/plain");
  return plain ?? "";
}

function findByMimeType(part: gmail_v1.Schema$MessagePart, mimeType: string): string | null {
  if (part.mimeType === mimeType && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  for (const child of part.parts ?? []) {
    const found = findByMimeType(child, mimeType);
    if (found) return found;
  }
  return null;
}

// Tenant-scoped existing-msg-id lookup. Chunked so we don't pass an IN-list
// of thousands of strings to Postgres.
async function findExistingMsgIds(userId: number, msgIds: string[]): Promise<Set<string>> {
  if (msgIds.length === 0) return new Set();
  const out = new Set<string>();
  const CHUNK = 500;
  for (let i = 0; i < msgIds.length; i += CHUNK) {
    const chunk = msgIds.slice(i, i + CHUNK);
    const rows = await db
      .select({ gmailMsgId: emailReceipts.gmailMsgId })
      .from(emailReceipts)
      .where(and(eq(emailReceipts.userId, userId), inArray(emailReceipts.gmailMsgId, chunk)));
    for (const r of rows) out.add(r.gmailMsgId);
  }
  return out;
}

// Resolve the authed Gmail client OR throw a typed connection error. Used by
// both dry-run and real backfill so bot/HTTP callers can branch on reason.
async function resolveAuthed(
  userId: number,
  getClient: (id: number) => Promise<AuthedGmailClient>,
): Promise<AuthedGmailClient> {
  try {
    return await getClient(userId);
  } catch (err) {
    if (err instanceof GmailNotConnectedError) {
      throw new BackfillConnectionError(
        "no active Gmail connection for this user",
        "not_connected",
      );
    }
    if (err instanceof GmailConnectionUnusableError) {
      throw new BackfillConnectionError(
        `Gmail connection unusable: ${err.status}`,
        err.status === "revoked" ? "revoked" : "unusable",
      );
    }
    throw err;
  }
}

// List every candidate message id matching the bancolombia sender query
// within [from, to]. Walks nextPageToken without a hard page cap — callers
// expected to invoke this only against a bounded date window.
async function listAllMsgIds(opts: {
  authed: AuthedGmailClient;
  q: string;
  sleep: (ms: number) => Promise<void>;
}): Promise<string[]> {
  const { authed, q, sleep } = opts;
  const allIds: string[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const res = await withRetry(
      () =>
        authed.gmail.users.messages.list({
          userId: "me",
          q,
          maxResults: 500,
          pageToken,
        }),
      { sleep },
    );
    const batch = res.data.messages ?? [];
    for (const m of batch) {
      if (m.id) allIds.push(m.id);
    }
    pageToken = res.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }
  return allIds;
}

function buildQuery(from: Date, to: Date): string {
  const cfg = getGatewayById("bancolombia");
  // `after:` is inclusive; `before:` is exclusive (midnight UTC of that day).
  return `${buildSenderQuery(cfg)} after:${toGmailDateQuery(from)} before:${toGmailDateQuery(to)}`;
}

/**
 * Dry-run preview: lists candidate emails and counts how many are new for
 * this user without fetching bodies or writing anything. Cheap — one Gmail
 * `list` call (5 quota units) per page.
 *
 * This is intentionally lighter than a "would-insert/would-skip" simulation:
 * the heavy signal is "N emails new, M already stored", which is enough to
 * confirm the user wants to proceed. Per-email parse/ingest outcomes are
 * only available after a real run.
 */
export async function backfillBancolombiaDryRun(
  userId: number,
  opts: BackfillOpts,
  deps: BackfillDeps = {},
): Promise<BackfillDryRunReport> {
  const getClient = deps.getClient ?? getAuthedClient;
  const sleep = deps.sleep ?? defaultSleep;
  const startedAt = Date.now();

  const authed = await resolveAuthed(userId, getClient);
  const q = buildQuery(opts.from, opts.to);

  try {
    const allIds = await listAllMsgIds({ authed, q, sleep });
    const existing = await findExistingMsgIds(userId, allIds);
    const alreadyStored = allIds.filter((id) => existing.has(id)).length;
    return {
      totalEmails: allIds.length,
      alreadyStored,
      newEmails: allIds.length - alreadyStored,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    if (isInvalidGrantError(err)) {
      await markConnectionUnusable(
        authed.connection.id,
        "revoked",
        "invalid_grant during backfill dry-run",
      );
      throw new BackfillConnectionError("Gmail refresh token revoked", "revoked");
    }
    throw err;
  }
}

/**
 * Real backfill: lists + fetches + inserts + ingests every new Bancolombia
 * notification email in [from, to]. Reuses the same parser and A+ dedup path
 * as the regular pull (#457) so semantics match exactly — running this after
 * a cron tick is idempotent.
 *
 * Tenant isolation: every DB read/write is scoped by `userId` via the
 * existing pipeline helpers. A caller that mishandles the userId cannot
 * cross-pollinate another tenant.
 *
 * Does NOT advance `gmail_connections.last_pull_at` — backfill is a
 * one-shot parallel operation and should not interfere with the cron
 * watermark.
 */
export async function backfillBancolombia(
  userId: number,
  opts: BackfillOpts,
  deps: BackfillDeps = {},
): Promise<BackfillReport> {
  const getClient = deps.getClient ?? getAuthedClient;
  const sleep = deps.sleep ?? defaultSleep;
  const startedAt = Date.now();
  const progressStride = opts.progressStride ?? DEFAULT_PROGRESS_STRIDE;
  const onProgress = opts.onProgress ?? (() => {});

  const report: BackfillReport = {
    totalEmails: 0,
    alreadyStored: 0,
    parsed: 0,
    skipped: 0,
    needsReview: 0,
    inserted: 0,
    matchedExisting: 0,
    sourceMismatches: 0,
    errors: [],
    durationMs: 0,
    canceled: false,
  };

  const authed = await resolveAuthed(userId, getClient);
  const q = buildQuery(opts.from, opts.to);

  let allIds: string[];
  try {
    await onProgress({ phase: "listing", processed: 0, total: 0 });
    allIds = await listAllMsgIds({ authed, q, sleep });
  } catch (err) {
    if (isInvalidGrantError(err)) {
      await markConnectionUnusable(
        authed.connection.id,
        "revoked",
        "invalid_grant during backfill list",
      );
      throw new BackfillConnectionError("Gmail refresh token revoked", "revoked");
    }
    report.errors.push({
      phase: "list",
      message: err instanceof Error ? err.message : String(err),
    });
    report.durationMs = Date.now() - startedAt;
    return report;
  }

  report.totalEmails = allIds.length;

  // Filter out already-stored msg_ids for this user so we don't re-fetch
  // bodies we already have. The dedup A+ layer also catches double-inserts
  // downstream, but skipping here saves quota and wall-clock time.
  const existing = await findExistingMsgIds(userId, allIds);
  const newIds = allIds.filter((id) => !existing.has(id));
  report.alreadyStored = allIds.length - newIds.length;

  // Fetch bodies + insert receipts one at a time. Each new receipt is then
  // fed through ingestParsedEmail in the same loop so memory pressure stays
  // O(1) — we never hold more than one raw body at a time.
  for (let i = 0; i < newIds.length; i++) {
    if (opts.shouldCancel && (await opts.shouldCancel())) {
      report.canceled = true;
      break;
    }

    const msgId = newIds[i];
    try {
      const res = await withRetry(
        () =>
          authed.gmail.users.messages.get({
            userId: "me",
            id: msgId,
            format: "full",
          }),
        { sleep },
      );
      const rawBody = extractBody(res.data.payload ?? undefined);
      if (!rawBody) {
        report.errors.push({
          phase: "get",
          messageId: msgId,
          message: "no text/html or text/plain body found",
        });
        continue;
      }

      const [inserted] = await db
        .insert(emailReceipts)
        .values({
          userId,
          gmailConnectionId: authed.connection.id,
          gmailMsgId: msgId,
          gateway: "bancolombia",
          rawHtml: rawBody,
        })
        .onConflictDoNothing()
        .returning({ id: emailReceipts.id });
      if (!inserted) {
        // Someone else (parallel cron / another /enriquecer) beat us to it.
        // Count as alreadyStored for the report and move on — the regular
        // pull will ingest whichever pending receipt is present.
        report.alreadyStored++;
        continue;
      }

      const parsed = parseBancolombiaEmail(rawBody);
      if (parsed.kind === "skip") {
        report.skipped++;
      } else if (parsed.kind === "needs_review") {
        report.needsReview++;
      } else {
        report.parsed++;
      }

      const outcome = await ingestParsedEmail(userId, parsed, inserted.id);
      if (outcome.status === "inserted") {
        report.inserted++;
      } else if (outcome.status === "duplicated") {
        report.matchedExisting++;
        if (outcome.flaggedMismatch) report.sourceMismatches++;
      } else if (outcome.status === "error") {
        report.errors.push({
          phase: "ingest",
          messageId: msgId,
          message: outcome.reason,
        });
      }
      // "skipped" ingest outcomes are already covered by the parser-skip
      // counter — no double count.

      // Rate-limit after every successful get so a long run doesn't exhaust
      // the per-user quota. Skipped when nothing to fetch (i === len - 1
      // branch falls through naturally).
      await sleep(DEFAULT_SLEEP_BETWEEN_GETS_MS);
    } catch (err) {
      if (isInvalidGrantError(err)) {
        await markConnectionUnusable(
          authed.connection.id,
          "revoked",
          "invalid_grant during backfill",
        );
        report.errors.push({
          phase: "auth",
          code: "invalid_grant",
          message: "refresh token revoked — connection marked revoked",
        });
        break;
      }
      log.error(
        { err, userId, gmailMsgId: msgId, event: "gmail_backfill_message_failed" },
        "failed to fetch/persist a backfill message",
      );
      report.errors.push({
        phase: "get",
        messageId: msgId,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const processedCount = i + 1;
    if (processedCount % progressStride === 0 || processedCount === newIds.length) {
      await onProgress({ phase: "fetching", processed: processedCount, total: newIds.length });
    }
  }

  await onProgress({
    phase: "done",
    processed: report.inserted + report.matchedExisting + report.skipped + report.needsReview,
    total: newIds.length,
  });
  report.durationMs = Date.now() - startedAt;
  log.info(
    {
      userId,
      totalEmails: report.totalEmails,
      inserted: report.inserted,
      matchedExisting: report.matchedExisting,
      sourceMismatches: report.sourceMismatches,
      errors: report.errors.length,
      canceled: report.canceled,
      durationMs: report.durationMs,
      event: "gmail_backfill_completed",
    },
    "bancolombia email backfill completed",
  );
  return report;
}
