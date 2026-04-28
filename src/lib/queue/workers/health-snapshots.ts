import type { Job } from "bullmq";

import { createLogger } from "@/lib/logger";
import { snapshotAllActiveUsers } from "@/lib/telemetry/user-health";
import { createWorker } from "@/lib/queue";

const log = createLogger({ module: "worker/health-snapshots" });

export type HealthSnapshotsJobData = Record<string, never>;

/**
 * Core processor: generate health snapshots for every active user.
 *
 * Runs daily at 03:00 America/Bogota — early enough that the /admin/health
 * page shows fresh data when the operator checks it in the morning, late
 * enough that yesterday's last SMS events have had time to land.
 *
 * Fan-out is synchronous inside a single job: per-user failures are logged
 * individually but never abort the overall loop. Churn-signal flags are
 * surfaced in the aggregated log line.
 *
 * Exported separately so tests can invoke it directly without a live Worker.
 */
export async function healthSnapshotsProcessor(job: Job<HealthSnapshotsJobData>): Promise<void> {
  log.info({ event: "health_snapshots_start", jobId: job.id }, "health-snapshots started");

  const results = await snapshotAllActiveUsers();

  const churned = results.filter((r) => r.ok && r.data.churnSignalFlag).length;
  const failed = results.filter((r) => !r.ok).length;

  log.info(
    { total: results.length, churned, failed, event: "user_health_snapshots_done", jobId: job.id },
    "user-health snapshots",
  );

  for (const entry of results) {
    if (!entry.ok) {
      log.error(
        { err: entry.error, userId: entry.userId, event: "user_health_snapshot_failed" },
        "user-health snapshot failed",
      );
    }
  }
}

/**
 * Create and register the health-snapshots BullMQ worker.
 *
 * Concurrency 1: fan-out is sequential inside a single job — running
 * multiple concurrent jobs would duplicate snapshot rows for the same
 * date window.
 *
 * Retry: 3 attempts with exponential back-off starting at 30s. A missed
 * snapshot is recoverable (the next daily run picks it up), so we don't
 * need aggressive retries.
 */
export function createHealthSnapshotsWorker() {
  return createWorker<HealthSnapshotsJobData, void>(
    "health-snapshots",
    async (job) => {
      try {
        await healthSnapshotsProcessor(job);
      } catch (err) {
        log.error(
          { err, event: "user_health_fanout_failed", jobId: job.id },
          "health-snapshots processor threw — BullMQ will retry",
        );
        throw err;
      }
    },
    {
      concurrency: 1,
    },
  );
}
