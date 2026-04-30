import type { gmail_v1 } from "googleapis";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailReceipts, gmailConnections } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { createLogger } from "@/lib/logger";
import {
  getAuthedClient,
  isInvalidGrantError,
  markConnectionUnusable,
  GmailConnectionUnusableError,
  GmailNotConnectedError,
  type AuthedGmailClient,
} from "@/lib/gmail/client";
import {
  GATEWAYS,
  buildSenderQuery,
  type GatewayConfig,
  type GatewayId,
} from "@/lib/gmail/registry";
import { parseBancolombiaEmail } from "@/lib/gmail/parsers/bancolombia";
import { parseReceipt } from "@/lib/gmail/parsers";
import { ingestParsedEmail } from "@/lib/ingestion/email-bancolombia";
import { processPendingArqReceipts } from "@/lib/ingestion/email-arq";
import { matchReceipt } from "@/lib/gmail/matcher";
import { applyEnrichment } from "@/lib/gmail/enrich";
import { pushToUser } from "@/lib/telegram/push";
import { renderReauthNudge } from "@/lib/telegram/formatter";
import { loadPendingAmbiguousReceipt } from "@/lib/telegram/disambiguation-query";
import { emitNotification } from "@/lib/notifications/emit";

const log = createLogger({ module: "gmail/pull" });

// Keeps the worst-case pull bounded if someone triggers /enriquecer after a
// long disconnect: 100 messages/page * 5 pages = 500 msgs/gateway per run.
// Subsequent runs pick up whatever remains (the watermark advances, but
// `after:` is inclusive so there is some overlap — dedup by msg_id handles
// that).
const MAX_PAGES_PER_GATEWAY = 5;
const PAGE_SIZE = 100;

// Cron runs hourly, but Gmail's `after:` resolution is seconds so a small
// overlap ensures we don't drop a message whose insertion we raced with.
// Dedup on (user_id, gmail_msg_id) absorbs the overlap.
const WATERMARK_OVERLAP_SECONDS = 30 * 60; // 30 min

// Max retries on 429 / 5xx before we surface the error. Low because the
// hourly cron will retry soon anyway; we're not trying to heroically finish
// a pull under load.
const MAX_RETRIES = 3;

export interface PullErrorDetail {
  gateway: GatewayId | "connection";
  phase: "auth" | "list" | "get" | "persist";
  messageId?: string;
  code?: string;
  message: string;
}

export type PullResult = {
  userId: number;
  pulled: number;
  skipped: number;
  byGateway: Record<GatewayId, { pulled: number; skipped: number }>;
  errors: PullErrorDetail[];
  // Null when the user has no active connection (caller decides how to
  // surface — bot replies with a connect link; cron just logs and moves on).
  connectionId: number | null;
};

export interface PullOpts {
  // When set, overrides the last-pull watermark with now-<sinceDays>.
  // Used by the manual backfill (#458) and tests.
  sinceDays?: number;
  // When provided, only pulls the named gateways. Otherwise scans all.
  gateways?: GatewayId[];
  // #498 — one-shot since-date override for re-bootstrap. Bypasses the
  // cursor (lastPullAt) for this single run; cursor advances normally after.
  overrideSince?: Date;
}

export interface PullDeps {
  // Swappable for tests — no need to spin up real OAuth or call Google.
  getClient?: (userId: number) => Promise<AuthedGmailClient>;
  now?: () => Date;
  // Sleep between retries. Tests override to avoid real waits.
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function sinceToQueryFragment(sinceDate: Date): string {
  // Gmail accepts a unix timestamp (seconds) after `after:`.
  const unixSeconds = Math.floor(sinceDate.getTime() / 1000);
  return `after:${unixSeconds}`;
}

export function computeSinceDate(opts: {
  now: Date;
  lastPullAt: Date | null;
  bootstrapSinceDate?: Date | null;
  sinceDays?: number;
  overrideSince?: Date | null;
}): Date {
  // 1. Explicit one-shot override (re-bootstrap action) — highest priority.
  if (opts.overrideSince != null) {
    return opts.overrideSince;
  }
  // 2. Legacy sinceDays explicit override (manual backfill, tests).
  if (opts.sinceDays !== undefined) {
    return new Date(opts.now.getTime() - opts.sinceDays * 86_400_000);
  }
  // 3. Normal watermark — cursor present, 30-min overlap to avoid gap races.
  if (opts.lastPullAt) {
    return new Date(opts.lastPullAt.getTime() - WATERMARK_OVERLAP_SECONDS * 1000);
  }
  // 4. Per-connection bootstrap window set by the user.
  if (opts.bootstrapSinceDate != null) {
    return opts.bootstrapSinceDate;
  }
  // 5. Final fallback: Jan 1 of current year (replaces the old 30-day rolling
  //    fallback so new connections don't silently re-ingest 30 days of history
  //    after a reset).
  const jan1 = new Date(opts.now.getFullYear(), 0, 1);
  return jan1;
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
  ctx: { gateway: GatewayId; phase: "list" | "get"; gmailEmail: string },
  deps: Required<Pick<PullDeps, "sleep">>,
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
      log.warn(
        {
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          delayMs,
          status,
          retryAfter,
          gateway: ctx.gateway,
          phase: ctx.phase,
          gmailEmail: ctx.gmailEmail,
          event: "gmail_pull_retry",
        },
        "retrying Gmail call after transient error",
      );
      await deps.sleep(delayMs);
    }
  }
  throw lastErr;
}

// Walks a Gmail MIME tree to find the best body. Prefers text/html because
// the downstream parsers (#453/#457) expect HTML. Falls back to text/plain
// if no HTML part is present (some gateways send plain-only for security).
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

// Tenant-scoped: returns ONLY msg_ids already stored for THIS userId.
// A cross-tenant race (same gmail_msg_id stored under userB) must not
// cause userA's pull to skip — the DB unique index is scoped to user_id.
async function findExistingMsgIds(userId: number, msgIds: string[]): Promise<Set<string>> {
  if (msgIds.length === 0) return new Set();
  const rows = await db
    .select({ gmailMsgId: emailReceipts.gmailMsgId })
    .from(emailReceipts)
    .where(and(eq(emailReceipts.userId, userId), inArray(emailReceipts.gmailMsgId, msgIds)));
  return new Set(rows.map((r) => r.gmailMsgId));
}

async function pullGateway(opts: {
  userId: number;
  connectionId: number;
  gmailEmail: string;
  authed: AuthedGmailClient;
  gateway: GatewayConfig;
  since: Date;
  deps: Required<Pick<PullDeps, "sleep">>;
}): Promise<{ pulled: number; skipped: number; errors: PullErrorDetail[] }> {
  const { userId, connectionId, gmailEmail, authed, gateway, since, deps } = opts;
  const errors: PullErrorDetail[] = [];
  const q = `${buildSenderQuery(gateway)} ${sinceToQueryFragment(since)}`;

  // 1) List all candidate message ids for this gateway.
  const allIds: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES_PER_GATEWAY; page++) {
    const res = await withRetry(
      () =>
        authed.gmail.users.messages.list({
          userId: "me",
          q,
          maxResults: PAGE_SIZE,
          pageToken,
        }),
      { gateway: gateway.id, phase: "list", gmailEmail },
      deps,
    );
    const batch = res.data.messages ?? [];
    for (const m of batch) {
      if (m.id) allIds.push(m.id);
    }
    pageToken = res.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }

  // 2) Filter out msg_ids we already have for THIS user.
  const existing = await findExistingMsgIds(userId, allIds);
  const newIds = allIds.filter((id) => !existing.has(id));
  const skipped = allIds.length - newIds.length;

  // 3) Fetch each new msg and persist. We do this one-at-a-time rather than
  // firing a batch because googleapis batch endpoints add complexity for
  // little wall-clock win at our scale (100s of msgs per pull, not 1000s).
  let pulled = 0;
  for (const msgId of newIds) {
    try {
      const res = await withRetry(
        () =>
          authed.gmail.users.messages.get({
            userId: "me",
            id: msgId,
            format: "full",
          }),
        { gateway: gateway.id, phase: "get", gmailEmail },
        deps,
      );
      const rawBody = extractBody(res.data.payload ?? undefined);
      if (!rawBody) {
        errors.push({
          gateway: gateway.id,
          phase: "get",
          messageId: msgId,
          message: "no text/html or text/plain body found",
        });
        continue;
      }
      // Idempotent insert — if a parallel pull (manual /enriquecer while
      // cron is also running) races us, onConflictDoNothing eats the dup.
      // No `target` specified because the unique index on
      // (user_id, gmail_msg_id) is partial (WHERE deleted_at IS NULL) and
      // Postgres rejects an ON CONFLICT target that doesn't match a full
      // unique constraint. Letting it bind to whichever unique constraint
      // violated is fine — emailReceipts has only the one.
      // Persist Gmail's internalDate so the parser step uses the real email
      // timestamp instead of the cron-run timestamp (#545). For real-time
      // notification emails (ARQ, PayPal, MP) this matches the underlying
      // transaction time within seconds.
      const internalDateMs = res.data.internalDate ? Number(res.data.internalDate) : null;
      const emailReceivedAt =
        internalDateMs !== null && Number.isFinite(internalDateMs)
          ? new Date(internalDateMs)
          : null;
      const insertResult = await db
        .insert(emailReceipts)
        .values({
          userId,
          gmailConnectionId: connectionId,
          gmailMsgId: msgId,
          gateway: gateway.id,
          rawHtml: rawBody,
          emailReceivedAt,
        })
        .onConflictDoNothing()
        .returning({ id: emailReceipts.id });
      if (insertResult.length > 0) pulled++;
    } catch (err) {
      // invalid_grant is a connection-level failure — abort the gateway
      // loop and let the outer pullForUser surface it.
      if (isInvalidGrantError(err)) throw err;
      log.error(
        {
          err,
          userId,
          gmailEmail,
          gateway: gateway.id,
          gmailMsgId: msgId,
          event: "gmail_pull_message_failed",
        },
        "failed to fetch/persist a Gmail message",
      );
      errors.push({
        gateway: gateway.id,
        phase: "get",
        messageId: msgId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { pulled, skipped, errors };
}

function emptyByGateway(): PullResult["byGateway"] {
  const out = {} as PullResult["byGateway"];
  for (const g of GATEWAYS) {
    out[g.id] = { pulled: 0, skipped: 0 };
  }
  return out;
}

/**
 * Parses + ingests every pending Bancolombia receipt for a user. Called at
 * the tail of `pullForUser` so freshly-inserted receipts get ingested in the
 * same cron tick AND stale pending rows from a previously-failed ingestion
 * get retried on every subsequent cron — no need for a separate reaper.
 *
 * A parse/ingest failure for one receipt is logged and does not interrupt
 * the loop; the receipt stays pending for the next tick to retry.
 */
async function processPendingBancolombiaReceipts(userId: number): Promise<void> {
  const pending = await db
    .select({ id: emailReceipts.id, rawHtml: emailReceipts.rawHtml })
    .from(emailReceipts)
    .where(
      and(
        eq(emailReceipts.userId, userId),
        eq(emailReceipts.gateway, "bancolombia"),
        eq(emailReceipts.matchStatus, "pending"),
        notDeleted(emailReceipts.deletedAt),
      ),
    );
  for (const receipt of pending) {
    try {
      const parsed = parseBancolombiaEmail(receipt.rawHtml);
      await ingestParsedEmail(userId, parsed, receipt.id);
    } catch (err) {
      log.error(
        {
          err,
          userId,
          receiptId: receipt.id,
          event: "gmail_bancolombia_ingest_failed",
        },
        "failed to parse+ingest bancolombia receipt; leaving as pending for retry",
      );
    }
  }
}

/**
 * Match and enrich every pending receipt for an enrich-mode gateway. Called
 * at the tail of `pullForUser` so freshly-inserted receipts are processed in
 * the same cron tick AND stale pending rows from a previously-failed match are
 * retried on every subsequent cron — no need for a separate reaper.
 *
 * Per-receipt errors are logged and do NOT interrupt the loop; the receipt
 * stays pending for the next tick to retry.
 *
 * Unmatched receipts are persisted with match_status='unmatched' but are
 * re-attempted on future pulls (the corresponding bank tx may not have arrived
 * via SMS yet at the time of the first pull).
 */
async function processPendingEnrichReceipts(userId: number, gatewayId: GatewayId): Promise<void> {
  const pending = await db
    .select({
      id: emailReceipts.id,
      rawHtml: emailReceipts.rawHtml,
      gateway: emailReceipts.gateway,
      gmailMsgId: emailReceipts.gmailMsgId,
      parsedAt: emailReceipts.parsedAt,
      createdAt: emailReceipts.createdAt,
      emailReceivedAt: emailReceipts.emailReceivedAt,
    })
    .from(emailReceipts)
    .where(
      and(
        eq(emailReceipts.userId, userId),
        eq(emailReceipts.gateway, gatewayId),
        inArray(emailReceipts.matchStatus, ["pending", "unmatched"]),
        notDeleted(emailReceipts.deletedAt),
      ),
    );

  for (const receipt of pending) {
    try {
      // Parse step: run the gateway parser if this receipt hasn't been parsed yet.
      // Receipts seeded with parsedAt already set (e.g. backfilled or pre-parsed
      // rows) skip parsing and proceed directly to matching.
      if (!receipt.parsedAt) {
        // emailReceivedAt is null for receipts ingested before #545; fall
        // back to createdAt for those so old receipts still parse.
        const parseResult = parseReceipt(receipt.gateway, receipt.rawHtml, {
          receivedAt: receipt.emailReceivedAt ?? receipt.createdAt,
        });

        if (parseResult.kind === "parsed") {
          const { merchant, amountCents, currency, occurredAt, referenceId } = parseResult.data;
          const parsedPayload = {
            merchant,
            amountCents: amountCents.toString(),
            currency,
            occurredAt: occurredAt.toISOString(),
            referenceId,
          };
          await db
            .update(emailReceipts)
            .set({
              merchant,
              amountCents,
              currency,
              occurredAt,
              referenceId,
              parsedPayload,
              parsedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(and(eq(emailReceipts.id, receipt.id), eq(emailReceipts.userId, userId)));
          log.info(
            {
              userId,
              receiptId: receipt.id,
              gateway: receipt.gateway,
              event: "gmail_receipt_parsed",
            },
            "receipt parsed successfully",
          );
        } else if (parseResult.kind === "skipped") {
          await db
            .update(emailReceipts)
            .set({ matchStatus: "unmatched", parsedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(emailReceipts.id, receipt.id), eq(emailReceipts.userId, userId)));
          log.info(
            {
              userId,
              receiptId: receipt.id,
              gateway: receipt.gateway,
              gmailMsgId: receipt.gmailMsgId,
              reason: parseResult.reason,
              event: "receipt_skipped",
            },
            "receipt skipped by parser; marked unmatched",
          );
          continue; // skip matcher — this receipt is intentionally non-transactional
        } else {
          // needs_review: leave as pending, do NOT call matcher
          log.warn(
            {
              userId,
              receiptId: receipt.id,
              gateway: receipt.gateway,
              gmailMsgId: receipt.gmailMsgId,
              reason: parseResult.reason,
              event: "receipt_needs_review",
            },
            "receipt parse needs review; leaving pending for retry",
          );
          continue;
        }
      }

      const result = await matchReceipt(userId, receipt.id);

      if (result.status === "matched") {
        await applyEnrichment(userId, result.transactionId, receipt.id);
      } else if (result.status === "ambiguous") {
        await db
          .update(emailReceipts)
          .set({
            matchStatus: "ambiguous",
            matchCandidates: result.candidateIds,
            updatedAt: new Date(),
          })
          .where(and(eq(emailReceipts.id, receipt.id), eq(emailReceipts.userId, userId)));
        log.info(
          {
            userId,
            receiptId: receipt.id,
            candidateIds: result.candidateIds,
            event: "gmail_enrich_ambiguous",
          },
          "receipt has ambiguous tx candidates; persisted for user disambiguation",
        );
        await emitNotification(userId, {
          type: "gmail_disambiguation_required",
          entityId: String(receipt.id),
          audience: "user",
          title: "Movimiento ambiguo: requiere tu confirmación",
          body: "Encontramos varios candidatos que matchean este recibo. Elegí cuál corresponde.",
          actionUrl: "/settings/integrations",
          priority: "high",
          metadata: { receiptId: receipt.id, gatewayId },
        }).catch((emitErr: unknown) => {
          log.error(
            {
              err: emitErr,
              userId,
              receiptId: receipt.id,
              event: "emit_disambiguation_required_failed",
            },
            "failed to emit gmail_disambiguation_required notification",
          );
        });
      } else {
        // unmatched: persist the status so it's queryable, but leave it
        // eligible for re-attempt on future pulls.
        await db
          .update(emailReceipts)
          .set({ matchStatus: "unmatched", updatedAt: new Date() })
          .where(and(eq(emailReceipts.id, receipt.id), eq(emailReceipts.userId, userId)));
        log.info(
          { userId, receiptId: receipt.id, gateway: gatewayId, event: "gmail_enrich_unmatched" },
          "no tx candidate found for receipt; will retry on next pull",
        );
      }
    } catch (err) {
      log.error(
        {
          err,
          userId,
          receiptId: receipt.id,
          gateway: gatewayId,
          event: "gmail_enrich_receipt_failed",
        },
        "failed to match/enrich receipt; leaving as pending for retry",
      );
    }
  }
}

/**
 * Send a re-auth Telegram nudge to a user when their Gmail connection is
 * expired or revoked. Throttled to at most once per 24h via `bot_nudge_sent_at`.
 *
 * The throttle check is a single atomic UPDATE with RETURNING so concurrent
 * pulls (manual /enriquecer + hourly cron) cannot both win the race and
 * deliver duplicate nudges within seconds of each other.
 */
async function maybeNudgeReauth(connectionId: number, userId: number): Promise<void> {
  // Atomic claim: only one concurrent pull wins the race. The WHERE clause
  // checks the 24h window atomically — if updated.length === 0, another
  // concurrent call already won or the throttle window hasn't elapsed.
  const updated = await db
    .update(gmailConnections)
    .set({ botNudgeSentAt: new Date() })
    .where(
      and(
        eq(gmailConnections.id, connectionId),
        or(
          isNull(gmailConnections.botNudgeSentAt),
          lt(gmailConnections.botNudgeSentAt, sql`now() - interval '24 hours'`),
        ),
      ),
    )
    .returning({ id: gmailConnections.id });

  if (updated.length === 0) {
    log.info(
      { userId, connectionId, event: "reauth_nudge_throttled" },
      "re-auth nudge throttled — sent within last 24h",
    );
    return;
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL ?? "";
  const result = await pushToUser(userId, renderReauthNudge(appUrl));
  if (!result.ok) {
    // We burned the throttle slot; log the failure clearly so on-call can
    // notice the user never saw the nudge (they'll get one on next 24h cycle).
    log.warn(
      { userId, connectionId, reason: result.reason, event: "reauth_nudge_no_channel" },
      "re-auth nudge throttle claimed but delivery failed — no bot/session",
    );
    return;
  }

  log.info({ userId, connectionId, event: "reauth_nudge_sent" }, "re-auth nudge sent via Telegram");
}

/**
 * After a successful pull, check whether any newly-ambiguous receipts need a
 * Telegram push prompt. Sends at most one prompt per pull cycle. If an
 * awaiting_disambiguation session already exists for the user, skips (the user
 * is already working through one).
 */
async function maybePushDisambiguationPrompt(userId: number): Promise<void> {
  // Use the helper that orders by updatedAt DESC so we always get the most
  // recent session when a user has multiple rows (e.g. different chat IDs
  // from re-installs). An inline query without orderBy would return an
  // arbitrary row and the push could reach a stale chat.
  const { getLatestSessionByUserId } = await import("@/lib/telegram/session");
  const sessionRow = await getLatestSessionByUserId(userId);

  if (!sessionRow) {
    // User has no Telegram session — no channel to push to.
    return;
  }

  if (sessionRow.state?.step === "awaiting_disambiguation") {
    log.info(
      { userId, event: "disambiguation_push_skipped" },
      "disambiguation push skipped — session already open",
    );
    return;
  }

  const pending = await loadPendingAmbiguousReceipt(userId);
  if (!pending) return;

  const { renderDisambiguationPrompt } = await import("@/lib/telegram/formatter");
  const text = renderDisambiguationPrompt({
    receiptId: pending.receipt.id,
    receiptMerchant: pending.receipt.merchant,
    receiptOccurredAt: pending.receipt.occurredAt,
    candidates: pending.candidates,
  });

  const result = await pushToUser(userId, text, "Markdown");
  if (!result.ok) {
    log.info(
      { userId, reason: result.reason, event: "disambiguation_push_no_channel" },
      "disambiguation push not delivered — no bot/session",
    );
    return;
  }

  // Open a 24h awaiting_disambiguation session so the user's reply is intercepted.
  const { upsertSession } = await import("@/lib/telegram/session");
  const chatId = Number(sessionRow.chatId);
  const telegramUserId = Number(sessionRow.telegramUserId);
  await upsertSession({
    chatId,
    userId,
    telegramUserId,
    state: {
      step: "awaiting_disambiguation",
      draft: {},
      sourceChatId: chatId,
      disambiguationReceiptId: pending.receipt.id,
      disambiguationCandidates: pending.candidates.map((c) => c.id),
    },
    ttlMs: 24 * 60 * 60 * 1000,
  });

  log.info(
    { userId, receiptId: pending.receipt.id, event: "disambiguation_push_sent" },
    "disambiguation push sent via Telegram",
  );
}

/**
 * Pull new Gmail messages for one user, store them in `email_receipts`, and
 * update the connection's `last_pull_at` watermark.
 *
 * Tenant isolation: every DB read/write is scoped by `userId`. A caller that
 * hands a userId from one request context cannot accidentally ingest into
 * another tenant's rows.
 *
 * Idempotency: safe to call repeatedly — duplicate `gmail_msg_id`s are
 * filtered before insert AND the DB has a UNIQUE `(user_id, gmail_msg_id)`.
 *
 * On `invalid_grant` (refresh token revoked / Google testing-mode 7-day
 * expiry): transitions the connection to `status='revoked'` and returns a
 * result with a `connection` error rather than throwing. The caller (cron
 * or /enriquecer) can surface a reconnect nudge.
 */
export async function pullForUser(
  userId: number,
  opts: PullOpts = {},
  deps: PullDeps = {},
): Promise<PullResult> {
  const getClient = deps.getClient ?? getAuthedClient;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ? deps.now() : new Date();

  const errors: PullErrorDetail[] = [];
  const byGateway = emptyByGateway();

  let authed: AuthedGmailClient;
  try {
    authed = await getClient(userId);
  } catch (err) {
    if (err instanceof GmailNotConnectedError) {
      return { userId, pulled: 0, skipped: 0, byGateway, errors, connectionId: null };
    }
    if (err instanceof GmailConnectionUnusableError) {
      errors.push({
        gateway: "connection",
        phase: "auth",
        code: err.status,
        message: err.message,
      });
      // Send re-auth nudge for expired/revoked connections (throttled 24h).
      // Look up the connection id to track botNudgeSentAt.
      if (err.status === "expired" || err.status === "revoked") {
        const [connRow] = await db
          .select({ id: gmailConnections.id })
          .from(gmailConnections)
          .where(and(eq(gmailConnections.userId, userId), notDeleted(gmailConnections.deletedAt)))
          .limit(1);
        if (connRow) {
          await maybeNudgeReauth(connRow.id, userId).catch((nudgeErr: unknown) => {
            log.error(
              { err: nudgeErr, userId, event: "reauth_nudge_failed" },
              "re-auth nudge threw",
            );
          });
          await emitNotification(userId, {
            type: "gmail_token_expired",
            entityId: String(connRow.id),
            audience: "user",
            title: "Gmail desconectado",
            body: "Findash dejó de leer tus recibos. Reconectá tu cuenta para seguir recibiendo movimientos.",
            actionUrl: "/settings/integrations",
            priority: "high",
            metadata: { connectionId: connRow.id },
          }).catch((emitErr: unknown) => {
            log.error(
              {
                err: emitErr,
                userId,
                connectionId: connRow.id,
                event: "emit_gmail_token_expired_failed",
              },
              "failed to emit gmail_token_expired notification",
            );
          });
        }
      }
      return { userId, pulled: 0, skipped: 0, byGateway, errors, connectionId: null };
    }
    throw err;
  }

  // Read watermark + bootstrap window for the since-date computation.
  const [connRow] = await db
    .select({
      lastPullAt: gmailConnections.lastPullAt,
      bootstrapSinceDate: gmailConnections.bootstrapSinceDate,
    })
    .from(gmailConnections)
    .where(eq(gmailConnections.id, authed.connection.id));
  const since = computeSinceDate({
    now,
    lastPullAt: connRow?.lastPullAt ?? null,
    bootstrapSinceDate: connRow?.bootstrapSinceDate ?? null,
    sinceDays: opts.sinceDays,
    overrideSince: opts.overrideSince,
  });

  const selectedGateways = opts.gateways
    ? GATEWAYS.filter((g) => opts.gateways!.includes(g.id))
    : GATEWAYS;

  let totalPulled = 0;
  let totalSkipped = 0;
  try {
    for (const gateway of selectedGateways) {
      const res = await pullGateway({
        userId,
        connectionId: authed.connection.id,
        gmailEmail: authed.connection.gmailEmail,
        authed,
        gateway,
        since,
        deps: { sleep },
      });
      byGateway[gateway.id] = { pulled: res.pulled, skipped: res.skipped };
      totalPulled += res.pulled;
      totalSkipped += res.skipped;
      errors.push(...res.errors);
    }
  } catch (err) {
    if (isInvalidGrantError(err)) {
      await markConnectionUnusable(authed.connection.id, "revoked", "invalid_grant during pull");
      errors.push({
        gateway: "connection",
        phase: "auth",
        code: "invalid_grant",
        message: "refresh token revoked — connection marked revoked",
      });
      // Send re-auth nudge (throttled 24h).
      await maybeNudgeReauth(authed.connection.id, userId).catch((nudgeErr: unknown) => {
        log.error(
          { err: nudgeErr, userId, event: "reauth_nudge_failed" },
          "re-auth nudge threw during invalid_grant handling",
        );
      });
      await emitNotification(userId, {
        type: "gmail_token_expired",
        entityId: String(authed.connection.id),
        audience: "user",
        title: "Gmail desconectado",
        body: "Findash dejó de leer tus recibos. Reconectá tu cuenta para seguir recibiendo movimientos.",
        actionUrl: "/settings/integrations",
        priority: "high",
        metadata: { connectionId: authed.connection.id, gmailEmail: authed.connection.gmailEmail },
      }).catch((emitErr: unknown) => {
        log.error(
          {
            err: emitErr,
            userId,
            connectionId: authed.connection.id,
            event: "emit_gmail_token_expired_failed",
          },
          "failed to emit gmail_token_expired notification",
        );
      });
      return {
        userId,
        pulled: totalPulled,
        skipped: totalSkipped,
        byGateway,
        errors,
        connectionId: authed.connection.id,
      };
    }
    throw err;
  }

  // Process ingest-mode receipts (#457 — bancolombia). This ALSO picks up
  // stale receipts from previous pulls whose ingestion errored mid-way, so a
  // transient DB hiccup doesn't lock a receipt into `pending` forever. Run
  // even if `errors` is non-empty — per-message list/get failures from the
  // Google side shouldn't block already-persisted receipts from being parsed.
  const ingestGatewaysSelected = selectedGateways.filter((g) => g.mode === "ingest");
  for (const g of ingestGatewaysSelected) {
    if (g.id === "bancolombia") {
      await processPendingBancolombiaReceipts(userId);
    } else if (g.id === "arq") {
      await processPendingArqReceipts(userId);
    }
  }

  // Process enrich-mode receipts (#454 — mercado_pago, payu, wompi, apple,
  // paypal). Stale pending receipts are retried on every pull — the bank tx
  // may not have arrived via SMS yet on the first attempt.
  const enrichGatewaysSelected = selectedGateways.filter((g) => g.mode === "enrich");
  for (const g of enrichGatewaysSelected) {
    await processPendingEnrichReceipts(userId, g.id);
  }

  // Only advance the watermark on fully successful pulls — partial failures
  // leave last_pull_at alone so the next run retries the same window. The
  // DB unique index on (user_id, gmail_msg_id) keeps that safe.
  if (errors.length === 0) {
    await db
      .update(gmailConnections)
      .set({ lastPullAt: now, updatedAt: now })
      .where(eq(gmailConnections.id, authed.connection.id));
  }

  // Only push a disambiguation prompt on fully clean pulls. If there were
  // errors the watermark stayed put, so the same receipts get retried next
  // cycle — we want to defer the push until a successful run to avoid
  // duplicate prompts on back-to-back cron ticks.
  if (errors.length === 0) {
    await maybePushDisambiguationPrompt(userId).catch((pushErr: unknown) => {
      log.error(
        { err: pushErr, userId, event: "disambiguation_push_failed" },
        "disambiguation push threw — not blocking pull result",
      );
    });
  }

  return {
    userId,
    pulled: totalPulled,
    skipped: totalSkipped,
    byGateway,
    errors,
    connectionId: authed.connection.id,
  };
}

/**
 * Fan-out across every active Gmail connection. Used by the hourly cron
 * and the HTTP cron route. Per-user failures are logged and do NOT break
 * the loop.
 *
 * `opts` is forwarded verbatim to each `pullForUser` call so callers can
 * override the pull window or restrict to specific gateways without touching
 * the per-user logic.
 */
export async function pullAllActiveConnections(
  deps: PullDeps = {},
  opts: PullOpts = {},
): Promise<PullResult[]> {
  const rows = await db
    .select({ userId: gmailConnections.userId })
    .from(gmailConnections)
    .where(and(eq(gmailConnections.status, "active"), notDeleted(gmailConnections.deletedAt)));
  const results: PullResult[] = [];
  for (const row of rows) {
    try {
      const res = await pullForUser(row.userId, opts, deps);
      results.push(res);
    } catch (err) {
      log.error(
        { err, userId: row.userId, event: "gmail_pull_user_failed" },
        "gmail pull failed for user",
      );
    }
  }
  return results;
}
