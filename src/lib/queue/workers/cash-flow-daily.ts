/**
 * Cash flow daily BullMQ worker — D.3 salary-gap + D.4 30d forecast.
 * Part of Epic I (#255), issue #715.
 *
 * Runs once daily at 08:00 America/Bogota for every active user.
 * Fan-out is synchronous: per-user failures are logged but never abort the loop.
 */

import type { Job } from "bullmq";

import { createLogger } from "@/lib/logger";
import { createWorker } from "@/lib/queue";
import { runCashFlowForecastForUser, runSalaryGapForUser } from "@/lib/insights/cash-flow";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

const log = createLogger({ module: "worker/cash-flow-daily" });

export type CashFlowDailyJobData = Record<string, never>;

// ---------------------------------------------------------------------------
// Processor — exported separately for direct test invocation
// ---------------------------------------------------------------------------

/**
 * Core processor: run salary-gap + cash flow forecast for every active user.
 *
 * Per-user failures are caught and logged individually — one user's failure
 * never blocks the rest of the fan-out.
 */
export async function cashFlowDailyProcessor(job: Job<CashFlowDailyJobData>): Promise<void> {
  log.info({ event: "cash_flow_daily_start", jobId: job.id }, "cash-flow-daily started");
  await job.updateProgress({ users: 0, done: false });
  await job.log("start: cash-flow-daily running salary-gap + forecast for all users");

  // Fetch current FX rate once for all users
  const fx = await getCurrentFxRate();

  // Load all active user IDs
  const userRows = await db.execute<{ id: number }>(sql`
    SELECT id FROM users WHERE deleted_at IS NULL ORDER BY id
  `);

  const today = new Date();
  let gapsTotal = 0;
  let forecastsRun = 0;
  let failures = 0;

  for (const { id: userId } of userRows) {
    try {
      // D.3 — salary-gap
      const { gapsEmitted } = await runSalaryGapForUser(userId, db, today);
      gapsTotal += gapsEmitted;

      // D.4 — 30d forecast
      await runCashFlowForecastForUser(userId, fx.rate, db, today);
      forecastsRun++;

      log.debug(
        { userId, gapsEmitted, event: "cash_flow_daily_user_ok" },
        "cash-flow-daily user processed",
      );
    } catch (err) {
      failures++;
      log.error(
        { err, userId, event: "cash_flow_daily_user_failed" },
        "cash-flow-daily failed for user",
      );
    }
  }

  await job.updateProgress({
    done: true,
    users: userRows.length,
    gapsTotal,
    forecastsRun,
    failures,
  });
  await job.log(
    `done: users=${userRows.length} gapsTotal=${gapsTotal} forecastsRun=${forecastsRun} failures=${failures}`,
  );

  log.info(
    {
      event: "cash_flow_daily_done",
      total: userRows.length,
      gapsTotal,
      forecastsRun,
      failures,
      jobId: job.id,
    },
    "cash-flow-daily complete",
  );
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

/**
 * Create and register the cash-flow-daily BullMQ worker.
 *
 * Concurrency 1: loops over all users synchronously, so multiple concurrent
 * jobs would duplicate work. Daily job — giving ample retry time is cheap.
 */
export function createCashFlowDailyWorker() {
  return createWorker<CashFlowDailyJobData, void>(
    "cash-flow-daily",
    async (job) => {
      try {
        await cashFlowDailyProcessor(job);
      } catch (err) {
        log.error(
          { err, event: "cash_flow_daily_fanout_failed", jobId: job.id },
          "cash-flow-daily processor threw — BullMQ will retry",
        );
        throw err;
      }
    },
    {
      concurrency: 1,
    },
  );
}
