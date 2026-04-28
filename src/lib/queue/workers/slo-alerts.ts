import type { Job } from "bullmq";

import { createLogger } from "@/lib/logger";
import { checkAndAlertSlos } from "@/lib/observability/slo-alerts";
import { createWorker } from "@/lib/queue";

const log = createLogger({ module: "worker/slo-alerts" });

export type SloAlertsJobData = Record<string, never>;

/**
 * Core processor: evaluate SLO metrics over a rolling 48h window and
 * fire/resolve Telegram alerts for breached SLOs.
 *
 * Runs every 30 minutes. Finer granularity is wasteful: the 48h evaluation
 * window swallows sub-half-hour deltas. Dedup is built into `slo_alerts`
 * (at most one unresolved row per sloKey), so repeated firings are idempotent.
 *
 * Exported separately so tests can invoke it directly without a live Worker.
 */
export async function sloAlertsProcessor(job: Job<SloAlertsJobData>): Promise<void> {
  log.info({ event: "slo_alerts_start", jobId: job.id }, "slo-alerts started");

  const decisions = await checkAndAlertSlos();

  const fired = decisions.filter((d) => d.action === "fire").length;
  const resolved = decisions.filter((d) => d.action === "resolve").length;
  const noops = decisions.filter((d) => d.action === "noop").length;

  log.info(
    { total: decisions.length, fired, resolved, noops, event: "slo_alerts_checked", jobId: job.id },
    "slo-alerts tick",
  );
}

/**
 * Create and register the slo-alerts BullMQ worker.
 *
 * Concurrency MUST be 1: the SLO evaluation reads+writes alert state in
 * Postgres (`slo_alerts` table). Running two jobs simultaneously could cause
 * duplicate fire events or race-condition resolves. Single-concurrency is
 * the correct model here since the job is lightweight (one DB read + optional
 * Telegram send) and runs only every 30 min.
 *
 * Retry: 3 attempts with exponential back-off starting at 10s. Alert misses
 * are recoverable — the next scheduled run re-evaluates the same window.
 */
export function createSloAlertsWorker() {
  return createWorker<SloAlertsJobData, void>(
    "slo-alerts",
    async (job) => {
      try {
        await sloAlertsProcessor(job);
      } catch (err) {
        log.error(
          { err, event: "slo_alerts_check_failed", jobId: job.id },
          "slo-alerts processor threw — BullMQ will retry",
        );
        throw err;
      }
    },
    {
      concurrency: 1,
    },
  );
}
