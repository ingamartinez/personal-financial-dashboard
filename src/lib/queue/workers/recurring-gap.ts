import type { Job } from "bullmq";

import { createLogger } from "@/lib/logger";
import { closePreviousMonthForAllUsers } from "@/lib/recurring/gap-detector";
import { createWorker } from "@/lib/queue";

const log = createLogger({ module: "worker/recurring-gap" });

export type RecurringGapJobData = Record<string, never>;

/**
 * Core processor: close previous-month recurring-transaction gaps for every
 * active user.
 *
 * Runs on day 5 of each month at 06:00 America/Bogota — gives a 4-day grace
 * window for late-posting SMS/Apple Pay events before we finalize gaps.
 *
 * Fan-out is synchronous inside a single job: per-user failures are logged
 * individually but never abort the overall loop. If the whole fan-out throws
 * (e.g. DB down), BullMQ retries the entire job.
 *
 * Exported separately so tests can invoke it directly without a live Worker.
 */
export async function recurringGapProcessor(job: Job<RecurringGapJobData>): Promise<void> {
  log.info({ event: "recurring_gap_start", jobId: job.id }, "recurring-gap started");

  const results = await closePreviousMonthForAllUsers();

  for (const entry of results) {
    if (entry.ok) {
      log.info(
        { userId: entry.userId, result: entry.result, event: "recurring_gap_closed" },
        `recurring-gap detector closed ${entry.result.yearMonth}`,
      );
    } else {
      log.error(
        { err: entry.error, userId: entry.userId, event: "recurring_gap_failed" },
        "recurring-gap detector failed",
      );
    }
  }

  log.info(
    {
      event: "recurring_gap_done",
      total: results.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      jobId: job.id,
    },
    "recurring-gap complete",
  );
}

/**
 * Create and register the recurring-gap BullMQ worker.
 *
 * Concurrency 1: the processor loops over all users synchronously, so running
 * multiple concurrent jobs would only duplicate work and could cause DB lock
 * contention on the same gap records.
 *
 * Retry: 3 attempts with exponential back-off starting at 60s. Monthly
 * job — giving ample time between retries is cheap.
 */
export function createRecurringGapWorker() {
  return createWorker<RecurringGapJobData, void>(
    "recurring-gap",
    async (job) => {
      try {
        await recurringGapProcessor(job);
      } catch (err) {
        log.error(
          { err, event: "recurring_gap_fanout_failed", jobId: job.id },
          "recurring-gap processor threw — BullMQ will retry",
        );
        throw err;
      }
    },
    {
      concurrency: 1,
    },
  );
}
