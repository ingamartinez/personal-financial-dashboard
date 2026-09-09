// #809: classify-sweep BullMQ worker.
// Runs weekly at 05:00 America/Bogota (Monday), one hour after the daily
// rule-proposals job's window opens for the week. Revisits the `otros`
// bucket for every active user — see src/lib/classification/sweep.ts for the
// full pipeline (prior art → rule engine → AI batch → proposal aggregation →
// settle).

import type { Job } from "bullmq";

import { createLogger } from "@/lib/logger";
import { runClassifySweep, type ClassifySweepResult } from "@/lib/classification/sweep";
import { createWorker } from "@/lib/queue";

const log = createLogger({ module: "worker/classify-sweep" });

export type ClassifySweepJobData = Record<string, never>;

/**
 * Core processor — exported separately for tests (no live Worker needed).
 */
export async function classifySweepProcessor(
  job: Job<ClassifySweepJobData>,
): Promise<ClassifySweepResult> {
  log.info({ event: "classify_sweep_start", jobId: job.id }, "classify-sweep started");

  await job.updateProgress({ phase: "sweeping" });
  await job.log("start: sweeping the otros bucket across all active users");

  const result = await runClassifySweep();

  for (const created of result.categoriesCreated) {
    log.info(
      {
        userId: created.userId,
        slug: created.slug,
        name: created.name,
        parentSlug: created.parentSlug,
        supportingTxCount: created.supportingTxIds.length,
        merchantExamples: created.merchantExamples,
        event: "classify_sweep_category_created_summary",
      },
      `classify-sweep created category "${created.slug}" for user ${created.userId}`,
    );
  }

  const summary = {
    usersProcessed: result.usersProcessed,
    totalPicked: result.totalPicked,
    totalPriorArtClassified: result.totalPriorArtClassified,
    totalRuleClassified: result.totalRuleClassified,
    totalAiClassified: result.totalAiClassified,
    totalSettledToOtros: result.totalSettledToOtros,
    categoriesCreated: result.categoriesCreated.length,
    failedUsers: result.failedUserIds.length,
  };

  if (result.failedUserIds.length > 0) {
    log.warn(
      { failedUserIds: result.failedUserIds, event: "classify_sweep_users_failed" },
      `classify-sweep: ${result.failedUserIds.length} user(s) failed and were skipped this run`,
    );
  }

  log.info({ ...summary, event: "classify_sweep_done" }, "classify-sweep complete");
  await job.updateProgress({ done: true, ...summary });
  await job.log(
    `done: users=${summary.usersProcessed} picked=${summary.totalPicked} priorArt=${summary.totalPriorArtClassified} rule=${summary.totalRuleClassified} ai=${summary.totalAiClassified} settled=${summary.totalSettledToOtros} categoriesCreated=${summary.categoriesCreated} failedUsers=${summary.failedUsers}`,
  );

  return result;
}

/**
 * Create and register the classify-sweep BullMQ worker.
 * Concurrency 1 — same rationale as classify-tx: avoid parallel Anthropic
 * calls; findash runs single-instance.
 */
export function createClassifySweepWorker() {
  return createWorker<ClassifySweepJobData, ClassifySweepResult>(
    "classify-sweep",
    async (job) => {
      try {
        return await classifySweepProcessor(job);
      } catch (err) {
        log.error(
          { err, event: "classify_sweep_failed", jobId: job.id },
          "classify-sweep processor threw — BullMQ will retry",
        );
        throw err;
      }
    },
    {
      concurrency: 1,
    },
  );
}
