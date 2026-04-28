import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { classifyByRule } from "@/lib/classification/rules";
import { createQueue } from "@/lib/queue";
import type { ClassifyTxJobData } from "@/lib/queue/workers/classify-tx";
import { createLogger } from "@/lib/logger";

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
 * Fire-and-forget: enqueue a classify-tx job for the given userId + txIds.
 *
 * Rules-based classification must have already run for these txs — this
 * helper enqueues only what the rule engine could NOT classify, so the AI
 * worker handles the remainder.
 *
 * Failure mode: if queue.add throws (Redis down, network blip) we log the
 * error and swallow it. The import already succeeded; the txs remain in
 * "unclassified" state and can be retried via the "Classify All Pending"
 * button (#592). Import correctness MUST NOT depend on Redis being up.
 */
export async function enqueueClassification(userId: number, txIds: number[]): Promise<void> {
  if (txIds.length === 0) return;

  try {
    const queue = createQueue<ClassifyTxJobData>("classify-tx");
    await queue.add("classify-tx", { userId, mode: "specific", txIds });
    log.info({ event: "classify_enqueued", userId, count: txIds.length }, "classify-tx enqueued");
  } catch (err) {
    log.error(
      { err, event: "classify_enqueue_failed", userId, count: txIds.length },
      "failed to enqueue classify-tx — txs remain pending (graceful degrade)",
    );
    // Intentionally NOT re-throwing. Import success must not depend on Redis.
  }
}
