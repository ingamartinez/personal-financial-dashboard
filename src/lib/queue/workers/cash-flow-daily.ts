/**
 * Cash flow daily BullMQ worker — D.3 salary-gap + D.4 30d forecast.
 * Part of Epic I (#255), issue #715.
 *
 * Runs once daily at 08:00 America/Bogota for every active user.
 * Fan-out is synchronous: per-user failures are logged but never abort the loop.
 */

import type { Job } from "bullmq";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { runCashFlowForecastForUser, runSalaryGapForUser } from "@/lib/insights/cash-flow";
import { runSavingsSuggestionForUser } from "@/lib/insights/savings-suggestions";
import { createLogger } from "@/lib/logger";
import { createWorker } from "@/lib/queue";

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

  // Deactivation is `users.active`. Do not copy the notDeleted() predicate
  // from transactions/accounts — that column does not exist on this table.
  const userRows = await db.select({ id: users.id }).from(users).where(eq(users.active, true));

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

      // C.1+C.2 — savings suggestions (fire-and-forget, quarterly dedup in emitNotification)
      // Pass the already-fetched FX rate so each user iteration avoids a redundant DB query.
      runSavingsSuggestionForUser(userId, db, fx.rate).catch((err: unknown) => {
        log.error({ err, userId, event: "savings_suggestion_failed" }, "savings suggestion failed");
      });

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
