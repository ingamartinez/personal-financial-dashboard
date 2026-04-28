import type { Job } from "bullmq";

import { createLogger } from "@/lib/logger";
import { classifyUnclassifiedBatch } from "@/lib/classification/pipeline";
import { countUnclassified } from "@/lib/transactions/queries";
import { createWorker } from "@/lib/queue";

const log = createLogger({ module: "worker/classify-tx" });

// Maximum loop iterations for drain-pending mode.
// 100 iterations × AI_BATCH_SIZE(20) = up to 2000 txs per job.
// Prevents runaway if the pending count never reaches zero due to a bug.
const MAX_DRAIN_ITERATIONS = 100;

export type ClassifyTxJobData =
  | { userId: number; mode: "specific"; txIds: number[] }
  | { userId: number; mode: "drain-pending" };

/**
 * Core processor: classifies transactions for a user.
 *
 * - mode "specific": classify only the given txIds (filtered AND user_id — tenant-safe).
 * - mode "drain-pending": loop calling classifyUnclassifiedBatch until no pending remain.
 *
 * Exported separately so tests can invoke it directly without a live Worker.
 */
export async function classifyTxProcessor(job: Job<ClassifyTxJobData>): Promise<void> {
  const { userId, mode } = job.data;

  log.info({ event: "classify_job_start", userId, mode, jobId: job.id }, "classify-tx started");

  if (mode === "specific") {
    const { txIds } = job.data;
    log.info(
      { event: "classify_specific_batch", userId, txCount: txIds.length, jobId: job.id },
      "classifying specific txIds",
    );

    const result = await classifyUnclassifiedBatch(userId, { txIds });

    log.info(
      {
        event: "classify_specific_done",
        userId,
        picked: result.picked,
        aiClassified: result.aiClassified,
        ruleClassified: result.ruleClassified,
        skipped: result.skipped,
        model: result.model,
        jobId: job.id,
      },
      "classify-tx specific done",
    );
    return;
  }

  // mode === "drain-pending"
  log.info(
    { event: "classify_drain_start", userId, jobId: job.id },
    "classify-tx drain-pending started",
  );

  let totalAiClassified = 0;
  let totalRuleClassified = 0;
  let totalSkipped = 0;
  let iterations = 0;

  while (iterations < MAX_DRAIN_ITERATIONS) {
    iterations++;

    const pendingCount = await countUnclassified(userId);
    log.info(
      { event: "classify_drain_tick", userId, pendingCount, iteration: iterations, jobId: job.id },
      "drain-pending tick",
    );

    if (pendingCount === 0) {
      log.info(
        {
          event: "classify_drain_done",
          userId,
          iterations,
          totalAiClassified,
          totalRuleClassified,
          totalSkipped,
          jobId: job.id,
        },
        "classify-tx drain-pending complete — no more pending",
      );
      return;
    }

    const result = await classifyUnclassifiedBatch(userId);

    totalAiClassified += result.aiClassified;
    totalRuleClassified += result.ruleClassified;
    totalSkipped += result.skipped;

    log.info(
      {
        event: "classify_drain_batch_done",
        userId,
        iteration: iterations,
        picked: result.picked,
        aiClassified: result.aiClassified,
        ruleClassified: result.ruleClassified,
        skipped: result.skipped,
        jobId: job.id,
      },
      "drain-pending batch done",
    );

    // If the pipeline picked zero even though pendingCount > 0, something is
    // wrong — break to avoid infinite spinning.
    if (result.picked === 0) {
      log.warn(
        {
          event: "classify_drain_stalled",
          userId,
          pendingCount,
          iteration: iterations,
          jobId: job.id,
        },
        "drain-pending stalled: pendingCount > 0 but pipeline picked 0 — aborting",
      );
      return;
    }
  }

  log.warn(
    {
      event: "classify_drain_limit_reached",
      userId,
      maxIterations: MAX_DRAIN_ITERATIONS,
      totalAiClassified,
      totalRuleClassified,
      totalSkipped,
      jobId: job.id,
    },
    "classify-tx drain-pending reached iteration limit — stopping",
  );
}

/**
 * Create and register the classify-tx BullMQ worker.
 *
 * Concurrency is set to 1 globally to avoid hammering Anthropic's API with
 * parallel classification requests. Multiple jobs can be enqueued but they
 * will process one at a time.
 *
 * Retry: 3 attempts with exponential back-off starting at 5s. Handles
 * transient Anthropic API failures without overwhelming the API.
 */
export function createClassifyTxWorker() {
  return createWorker<ClassifyTxJobData, void>(
    "classify-tx",
    async (job) => {
      try {
        await classifyTxProcessor(job);
      } catch (err) {
        log.error(
          {
            err,
            event: "classify_job_failed",
            userId: job.data.userId,
            mode: job.data.mode,
            jobId: job.id,
          },
          "classify-tx job failed",
        );
        // Re-throw so BullMQ records the failure and triggers retries.
        throw err;
      }
    },
    {
      concurrency: 1,
    },
  );
}
