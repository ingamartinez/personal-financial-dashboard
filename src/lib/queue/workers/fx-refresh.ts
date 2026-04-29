import type { Job } from "bullmq";

import { createLogger } from "@/lib/logger";
import { fetchTrm } from "@/lib/fx/trm";
import { upsertFxRate } from "@/lib/fx/repo";
import { createWorker } from "@/lib/queue";

const log = createLogger({ module: "worker/fx-refresh" });

export type FxRefreshJobData = {
  reason?: "boot-backfill" | "manual";
};

/**
 * Core processor: fetch TRM rate from SuperFinanciera and upsert into fx_rates.
 * Exported separately so tests can invoke it directly without a live Worker.
 */
export async function fxRefreshProcessor(job: Job<FxRefreshJobData>): Promise<void> {
  const trigger = job.data.reason ?? "scheduled";
  log.info({ event: "fx_refresh_start", trigger, jobId: job.id }, "fx-refresh started");

  await job.updateProgress({ phase: "fetching" });
  await job.log(`start: trigger=${trigger}`);

  const trm = await fetchTrm();

  await job.updateProgress({ phase: "persisted", source: trm.source });
  await job.log(`fetched: rate=${trm.rate} asOf=${trm.asOf} source=${trm.source}`);

  await upsertFxRate({
    base: "USD",
    quote: "COP",
    rate: trm.rate,
    asOf: trm.asOf,
    source: trm.source,
  });

  await job.updateProgress({ phase: "done", source: trm.source, rate: trm.rate });
  await job.log(`done: rate=${trm.rate} asOf=${trm.asOf}`);

  log.info(
    { event: "fx_refresh_done", rate: trm.rate, observedAt: trm.asOf, trigger },
    "fx-refresh complete",
  );
}

/**
 * Create and register the fx-refresh BullMQ worker.
 *
 * Each worker gets its own ioredis connection (BullMQ requirement — workers
 * use blocking BLPOP, which is incompatible with sharing a connection used
 * by Queue for enqueueing).
 *
 * The worker is added to the global workerRegistry via createWorker() so that
 * registerGracefulShutdown() in src/lib/queue/index.ts drains it cleanly on
 * SIGTERM.
 *
 * Retry: 3 attempts with exponential back-off starting at 30s. Gives the
 * external SuperFinanciera API time to recover from transient failures without
 * hammering it immediately.
 */
export function createFxRefreshWorker() {
  return createWorker<FxRefreshJobData, void>(
    "fx-refresh",
    async (job) => {
      try {
        await fxRefreshProcessor(job);
      } catch (err) {
        log.error(
          {
            err,
            event: "fx_refresh_failed",
            trigger: job.data.reason ?? "scheduled",
            jobId: job.id,
          },
          "fx-refresh failed",
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
