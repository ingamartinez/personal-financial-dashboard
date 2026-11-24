import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { classifyByRule } from "@/lib/classification/rules";
import { createQueue } from "@/lib/queue";
import type { ClassifyTxJobData } from "@/lib/queue/workers/classify-tx";
import { createLogger } from "@/lib/logger";

export type ClassifyAskJobData = { mode: "all" } | { mode: "single-user"; userId: number };

const log = createLogger({ module: "classify-enqueue" });

/**
 * Run classifyByRule on a set of freshly-inserted transaction IDs, persist
 * the rule match when found, then enqueue AI classification for the remainder.
 *
 * Used by import paths (Excel/PDF) that insert txs WITHOUT calling
 * classifyByRule first (unlike the SMS pipeline which runs rules inline).
 *
 * Tenant safety: every SELECT and UPDATE filters by `userId AND id IN (txIds)`.
 * If a caller ever passes a txIds list that contains another user's row id,
 * the WHERE clause silently drops it — no cross-tenant read or write possible.
 * Per memory `per-user-table-join-tenant-safety.md` (#336/#338): trust no
 * caller-provided invariant; enforce at the DB layer.
 */
export async function classifyByRuleThenEnqueue(userId: number, txIds: number[]): Promise<void> {
  if (txIds.length === 0) return;

  // Fetch the minimal fields needed for rule matching in a single query.
  const rows = await db
    .select({
      id: transactions.id,
      descriptionRaw: transactions.descriptionRaw,
      merchant: transactions.merchant,
    })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), inArray(transactions.id, txIds)));

  const unclassifiedIds: number[] = [];

  for (const row of rows) {
    const match = await classifyByRule(userId, {
      descriptionRaw: row.descriptionRaw,
      merchant: row.merchant,
    });

    if (match) {
      // Rule matched — update the tx in place. userId guard re-asserted
      // here even though the SELECT above already enforced it; defense-in-
      // depth against a caller manually splicing rows[] across users.
      await db
        .update(transactions)
        .set({
          categorySlug: match.categorySlug,
          classificationMethod: "rule",
          classificationConfidence: match.confidence,
          updatedAt: new Date(),
        })
        .where(and(eq(transactions.userId, userId), eq(transactions.id, row.id)));
      log.info(
        {
          event: "rule_matched_on_import",
          userId,
          txId: row.id,
          categorySlug: match.categorySlug,
          ruleId: match.ruleId,
        },
        "rule matched on import — tx classified inline",
      );
    } else {
      unclassifiedIds.push(row.id);
    }
  }

  await enqueueClassification(userId, unclassifiedIds);
}

/**
 * S1 (#1040): how long `enqueueClassification` waits for `queue.add` before it
 * declares the job deferred. The connection keeps `maxRetriesPerRequest: null`
 * (BullMQ requires it), so a `queue.add` against a down Redis never rejects —
 * the bound has to live at this call site.
 */
export const DEFAULT_ENQUEUE_TIMEOUT_MS = 5_000;

export type EnqueueClassificationOptions = {
  /** Override the call-site bound, in milliseconds. */
  timeoutMs?: number;
};

const DEFERRED = Symbol("classify-enqueue-deferred");

/**
 * Race `add` against an unref'd, always-cleared timer.
 *
 * The timer resolves instead of rejecting: a pending `queue.add` is not a
 * failure, it is a job we are no longer waiting for. Clearing it in `finally`
 * keeps the happy path (S3) at zero added latency, and `unref()` stops a
 * pending bound from holding the process — or a Vitest worker — alive (the
 * same discipline as #1039's backfill row timeout).
 */
async function settleWithin<T>(add: Promise<T>, timeoutMs: number): Promise<T | typeof DEFERRED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof DEFERRED>((resolve) => {
    timer = setTimeout(() => resolve(DEFERRED), timeoutMs);
    timer.unref();
  });

  try {
    return await Promise.race([add, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Fire-and-forget: enqueue a classify-tx job for the given userId + txIds.
 *
 * Rules-based classification must have already run for these txs — this
 * helper enqueues only what the rule engine could NOT classify, so the AI
 * worker handles the remainder.
 *
 * Failure modes (import correctness MUST NOT depend on Redis being up):
 * - `queue.add` rejects (Redis explicitly down, bad payload) → log the error
 *   and swallow it. The txs stay "unclassified" and can be retried via the
 *   "Classify All Pending" button (#592).
 * - `queue.add` never settles (#1040) → `maxRetriesPerRequest: null` means
 *   ioredis just waits while Redis is unreachable. The call is bounded by
 *   `timeoutMs` (default `DEFAULT_ENQUEUE_TIMEOUT_MS`) and resolves as
 *   **deferred**: the tx is already persisted and the classify sweep picks it
 *   up later. Deferred is logged as a warning, never as an error — reporting a
 *   deferral as a failure would page someone over correctly-recorded money.
 *
 * There is deliberately no retry loop here: retrying a `queue.add` that never
 * settles only multiplies the hang (#1039, L3).
 */
export async function enqueueClassification(
  userId: number,
  txIds: number[],
  opts: EnqueueClassificationOptions = {},
): Promise<void> {
  if (txIds.length === 0) return;

  const timeoutMs = opts.timeoutMs ?? DEFAULT_ENQUEUE_TIMEOUT_MS;
  const startedAt = Date.now();

  try {
    const queue = createQueue<ClassifyTxJobData>("classify-tx");
    const result = await settleWithin(
      queue.add("classify-tx", { userId, mode: "specific", txIds }),
      timeoutMs,
    );

    if (result === DEFERRED) {
      log.warn(
        {
          event: "classify_enqueue_deferred",
          outcome: "deferred",
          userId,
          txIds,
          count: txIds.length,
          timeoutMs,
          elapsedMs: Date.now() - startedAt,
        },
        "classify-tx enqueue still pending after the bound — txs deferred to the classify sweep",
      );
      return;
    }

    log.info({ event: "classify_enqueued", userId, count: txIds.length }, "classify-tx enqueued");
  } catch (err) {
    log.error(
      { err, event: "classify_enqueue_failed", outcome: "failed", userId, count: txIds.length },
      "failed to enqueue classify-tx — txs remain pending (graceful degrade)",
    );
    // Intentionally NOT re-throwing. Import success must not depend on Redis.
  }
}

/**
 * Fire-and-forget: enqueue a classify-ask job for one user.
 * The worker sends at most one Telegram question; this only schedules it.
 * Failure is swallowed — the recurring scanner will pick the row up later.
 */
export async function enqueueAskUser(userId: number): Promise<void> {
  try {
    const queue = createQueue<ClassifyAskJobData>("classify-ask");
    await queue.add("classify-ask", { mode: "single-user", userId });
    log.info({ event: "classify_ask_enqueued", userId }, "classify-ask enqueued");
  } catch (err) {
    log.error(
      { err, event: "classify_ask_enqueue_failed", userId },
      "failed to enqueue classify-ask — will wait for the recurring scanner",
    );
  }
}
