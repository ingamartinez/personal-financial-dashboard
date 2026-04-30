import type { Job } from "bullmq";

import { createLogger } from "@/lib/logger";
import { pullForUser, pullAllActiveConnections } from "@/lib/gmail/pull";
import type { PullOpts } from "@/lib/gmail/pull";
import { createWorker } from "@/lib/queue";
import { emit } from "@/lib/events/bus";

const log = createLogger({ module: "worker/gmail-pull" });

// ---------------------------------------------------------------------------
// Job data shapes
//
// Design decision: in-worker fan-out (NOT parent+child jobs).
//
// The scheduled job calls pullAllActiveConnections() in one go — sequential
// fan-out inside a single tick. Individual per-user retries were never part
// of the contract (a failed user is logged and the next tick picks up
// naturally). Introducing a parent→child job pattern would:
//   (a) triple the Redis round-trips per tick (parent enqueue + N child enqueues
//       + N acks), and
//   (b) require a "parent job" concept that BullMQ only natively supports via
//       BullMQ Pro flows — non-trivial to add safely.
//
// Therefore we keep the simpler approach: the scheduled job runs the full
// fan-out inside the processor. Per-user errors are caught, logged, and do
// not abort the loop (existing behavior preserved exactly).
//
// User-triggered pulls (previously queueMicrotask in actions.ts) use the
// "single-user" mode below so they target one user without touching others.
// ---------------------------------------------------------------------------

export type GmailPullJobData =
  | {
      mode: "all";
      opts?: PullOpts;
    }
  | {
      mode: "single-user";
      userId: number;
      opts?: PullOpts;
    };

/**
 * Core processor: pull Gmail receipts for one user or all active connections.
 *
 * - mode "all": fan-out to every active gmail_connections row. Per-user
 *   failures are logged but never abort the loop. This is the scheduled cron
 *   path (every 5 min).
 * - mode "single-user": pull only for the given user. Used by user-triggered
 *   pulls from the settings/integrations page (replaces queueMicrotask calls).
 *   Tenant-safe: userId comes from the authenticated session (caller responsibility).
 *
 * Exported separately so tests can invoke it directly without a live Worker.
 */
export async function gmailPullProcessor(job: Job<GmailPullJobData>): Promise<void> {
  const { mode } = job.data;

  log.info({ event: "gmail_pull_start", mode, jobId: job.id }, "gmail-pull started");

  if (mode === "single-user") {
    const { userId, opts = {} } = job.data;

    log.info(
      { event: "gmail_pull_single_user_start", userId, jobId: job.id },
      "gmail-pull single-user",
    );

    await job.updateProgress({ userId, phase: "auth" });
    await job.log(`start: mode=single-user userId=${userId}`);

    emit({
      type: "job:progress",
      jobName: "gmail-pull",
      // job.id is string | undefined in BullMQ types; String() guards the undefined case.
      jobId: String(job.id),
      userId,
      phase: "pulling",
      timestamp: Date.now(),
    });

    const result = await pullForUser(userId, opts);

    log.info(
      {
        event: "gmail_pull_single_user_done",
        userId,
        pulled: result.pulled,
        skipped: result.skipped,
        errors: result.errors.length,
        jobId: job.id,
      },
      "gmail-pull single-user done",
    );

    await job.updateProgress({
      done: true,
      userId,
      pulled: result.pulled,
      skipped: result.skipped,
      errors: result.errors.length,
    });
    await job.log(
      `done: userId=${userId} pulled=${result.pulled} skipped=${result.skipped} errors=${result.errors.length}`,
    );

    emit({
      type: "job:done",
      jobName: "gmail-pull",
      jobId: String(job.id),
      userId,
      newTxCount: result.pulled,
      processedCount: result.pulled + result.skipped,
      timestamp: Date.now(),
    });

    return;
  }

  // mode === "all"
  const { opts = {} } = job.data;

  await job.updateProgress({ users: 0, total: 0 });
  await job.log("start: mode=all pulling all active connections");

  const results = await pullAllActiveConnections({}, opts);

  const totalPulled = results.reduce((acc, r) => acc + r.pulled, 0);
  const totalSkipped = results.reduce((acc, r) => acc + r.skipped, 0);
  const withErrors = results.filter((r) => r.errors.length > 0).length;

  log.info(
    {
      users: results.length,
      pulled: totalPulled,
      skipped: totalSkipped,
      withErrors,
      event: "gmail_pull_cron_tick",
      jobId: job.id,
    },
    "gmail pull cron tick",
  );

  await job.updateProgress({
    done: true,
    totalPulled,
    totalSkipped,
    withErrors,
  });
  await job.log(
    `done: users=${results.length} pulled=${totalPulled} skipped=${totalSkipped} withErrors=${withErrors}`,
  );
}

/**
 * Create and register the gmail-pull BullMQ worker.
 *
 * Concurrency 1: even though per-user pulls are independent, running two
 * fan-out jobs simultaneously could create N×2 concurrent Gmail API calls
 * (one from the scheduled tick + one from a user-triggered pull landing at
 * the same time). For the current single-instance deployment this is
 * acceptable if concurrency > 1, but 1 keeps the Redis repeat dedup simpler
 * and avoids Google rate-limit edge cases. Revisit when multi-instance scaling
 * is added (see Epic #586 out-of-scope note).
 *
 * Retry: 3 attempts. The per-user fan-out already catches individual user
 * errors — retries here guard against transient DB failures at the top level.
 */
export function createGmailPullWorker() {
  return createWorker<GmailPullJobData, void>(
    "gmail-pull",
    async (job) => {
      try {
        await gmailPullProcessor(job);
      } catch (err) {
        log.error(
          { err, event: "gmail_pull_fanout_failed", mode: job.data.mode, jobId: job.id },
          "gmail-pull processor threw — BullMQ will retry",
        );
        throw err;
      }
    },
    {
      concurrency: 1,
    },
  );
}
