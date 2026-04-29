import type { Job } from "bullmq";
import { and, inArray, isNull, lt, sql } from "drizzle-orm";

import { createLogger } from "@/lib/logger";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { createWorker } from "@/lib/queue";

const log = createLogger({ module: "worker/classification-auto-uncategorize" });

export type ClassificationAutoUncategorizeJobData = Record<string, never>;

/**
 * Core processor: move stale low-confidence inbox rows to "otros" with
 * method=user_uncategorized. Runs daily at 04:00 America/Bogota.
 *
 * Criteria (all must match):
 *   - classificationMethod IN ('rule', 'ai')  — still in the inbox
 *   - classificationConfidence < 60           — low confidence
 *   - occurredAt < NOW() - INTERVAL '30 days' — stale
 *   - deletedAt IS NULL                       — not soft-deleted
 *
 * This is a null-signal action — same as the user clicking "No me acuerdo".
 * It does NOT insert into classification_corrections so the learning loop
 * is never polluted with ambiguous auto-decisions.
 *
 * Exported separately so tests can invoke it directly without a live Worker.
 */
export async function classificationAutoUncategorizeProcessor(
  job: Job<ClassificationAutoUncategorizeJobData>,
): Promise<{ rowsUpdated: number }> {
  log.info(
    { event: "auto_uncategorize_start", jobId: job.id },
    "classification-auto-uncategorize started",
  );

  const result = await db
    .update(transactions)
    .set({
      categorySlug: "otros",
      classificationMethod: "user_uncategorized",
      classificationConfidence: 100,
      classificationReason: JSON.stringify({
        action: "auto_uncategorized",
        reason: "30d_inbox_stragglers",
      }),
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(transactions.classificationMethod, ["rule", "ai"]),
        lt(transactions.classificationConfidence, 60),
        sql`${transactions.occurredAt} < NOW() - INTERVAL '30 days'`,
        isNull(transactions.deletedAt),
      ),
    )
    .returning({ id: transactions.id });

  const rowsUpdated = result.length;

  log.info(
    { event: "auto_uncategorize_completed", rowsUpdated },
    "auto-uncategorize batch finished",
  );

  return { rowsUpdated };
}

/**
 * Create and register the classification-auto-uncategorize BullMQ worker.
 *
 * Concurrency 1: single bulk UPDATE — no fan-out needed, the WHERE clause
 * handles all tenants at once via column constraints.
 */
export function createClassificationAutoUncategorizeWorker() {
  return createWorker<ClassificationAutoUncategorizeJobData, { rowsUpdated: number }>(
    "classification-auto-uncategorize",
    async (job) => {
      try {
        return await classificationAutoUncategorizeProcessor(job);
      } catch (err) {
        log.error(
          { err, event: "auto_uncategorize_failed", jobId: job.id },
          "classification-auto-uncategorize processor threw — BullMQ will retry",
        );
        throw err;
      }
    },
    {
      concurrency: 1,
    },
  );
}
