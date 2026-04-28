// globalThis singleton guards against Turbopack/HMR re-entering registerNode()
// and spawning duplicate BullMQ repeat schedules.
declare global {
  var __findashBgRegistered: boolean | undefined;
}

/**
 * Node-runtime instrumentation body — runs once per worker on boot. Registers:
 * - fx-refresh BullMQ recurring job (twice daily, 06:15 and 18:15 America/Bogota)
 * - recurring-gap BullMQ recurring job (monthly, day 5 at 06:00 America/Bogota)
 * - health-snapshots BullMQ recurring job (daily 03:00 America/Bogota)
 * - slo-alerts BullMQ recurring job (every 30 min)
 * - gmail-pull BullMQ recurring job (every 5 min)
 * - classify-tx BullMQ worker (on-demand jobs from import pipelines and UI)
 *
 * All scheduling goes through BullMQ (#593 removed the prior scheduler).
 * Manual overrides use Bull-Board's Promote/Retry buttons.
 *
 * Telegram used to run a long-poll worker here; #185 moved it to per-user
 * webhooks (`src/app/api/telegram/webhook/[botId]/route.ts`) so there is no
 * background worker to wire up anymore.
 *
 * Loaded via `require()` from `instrumentation.ts` behind a `NEXT_RUNTIME`
 * guard so Turbopack's Edge pass never traces this file (#380). Disable all
 * crons with `FINDASH_DISABLE_CRON=1`.
 */
export async function registerNode() {
  if (process.env.FINDASH_DISABLE_CRON === "1") return;
  if (globalThis.__findashBgRegistered) return;
  globalThis.__findashBgRegistered = true;

  const { getCurrentFxRate } = await import("@/lib/fx/repo");
  const { createLogger } = await import("@/lib/logger");
  const { createQueue, registerGracefulShutdown } = await import("@/lib/queue");
  const { createFxRefreshWorker } = await import("@/lib/queue/workers/fx-refresh");
  const { createClassifyTxWorker } = await import("@/lib/queue/workers/classify-tx");
  const { createRecurringGapWorker } = await import("@/lib/queue/workers/recurring-gap");
  const { createHealthSnapshotsWorker } = await import("@/lib/queue/workers/health-snapshots");
  const { createSloAlertsWorker } = await import("@/lib/queue/workers/slo-alerts");
  const { createGmailPullWorker } = await import("@/lib/queue/workers/gmail-pull");
  const log = createLogger({ module: "instrumentation" });

  // -------------------------------------------------------------------------
  // BullMQ: create all queues and workers
  //
  // jobId is the idempotency key for repeat entries — without it, every
  // Next.js restart would add another copy of the schedule to Redis.
  // With it, BullMQ deduplicates to exactly one recurring job regardless of
  // how many times registerNode() runs (the globalThis guard above also helps,
  // but jobId is the true safety net at the BullMQ layer).
  // -------------------------------------------------------------------------

  // fx-refresh: twice daily at 06:15 and 18:15 COT
  const fxQueue = createQueue("fx-refresh");
  createFxRefreshWorker();

  // classify-tx: on-demand, no repeat schedule
  createQueue("classify-tx");
  createClassifyTxWorker();

  // recurring-gap: monthly, day 5 at 06:00 COT
  const recurringGapQueue = createQueue("recurring-gap");
  createRecurringGapWorker();

  // health-snapshots: daily at 03:00 COT
  const healthSnapshotsQueue = createQueue("health-snapshots");
  createHealthSnapshotsWorker();

  // slo-alerts: every 30 min
  const sloAlertsQueue = createQueue("slo-alerts");
  createSloAlertsWorker();

  // gmail-pull: every 5 min — fan-out to all active connections
  const gmailPullQueue = createQueue("gmail-pull");
  createGmailPullWorker();

  // Graceful shutdown is idempotent — safe to call once after all workers are
  // registered.
  registerGracefulShutdown();

  // -------------------------------------------------------------------------
  // Register recurring schedules
  // -------------------------------------------------------------------------

  await fxQueue.add(
    "fx-refresh",
    {},
    {
      repeat: { pattern: "15 6,18 * * *", tz: "America/Bogota" },
      jobId: "fx-refresh-recurring",
    },
  );

  // Day 5 of each month at 06:00 America/Bogota — gives a 4-day grace window
  // for late-posting SMS/Apple Pay events before we finalize gaps.
  await recurringGapQueue.add(
    "recurring-gap",
    {},
    {
      repeat: { pattern: "0 6 5 * *", tz: "America/Bogota" },
      jobId: "recurring-gap-recurring",
    },
  );

  // 03:00 COT daily — early enough to be ready before the operator checks
  // /admin/health in the morning, late enough that yesterday's last SMS had
  // time to land.
  await healthSnapshotsQueue.add(
    "health-snapshots",
    {},
    {
      repeat: { pattern: "0 3 * * *", tz: "America/Bogota" },
      jobId: "health-snapshots-recurring",
    },
  );

  // Every 30 min — evaluate each SLO over a rolling 48h window and fire /
  // resolve Telegram alerts (#329 PR3, #341 wiring). Finer granularity is
  // wasteful: the 48h window swallows sub-half-hour deltas. Dedup is built
  // into `slo_alerts` (at most one unresolved row per sloKey).
  await sloAlertsQueue.add(
    "slo-alerts",
    {},
    {
      repeat: { pattern: "*/30 * * * *", tz: "America/Bogota" },
      jobId: "slo-alerts-recurring",
    },
  );

  // Every 5 min — fan-out over every active gmail_connections row. Per-user
  // failures are logged but do NOT break the loop. Manual overrides go through
  // Bull-Board's Promote/Retry buttons (#593).
  await gmailPullQueue.add(
    "gmail-pull",
    { mode: "all" },
    {
      repeat: { pattern: "*/5 * * * *", tz: "America/Bogota" },
      jobId: "gmail-pull-recurring",
    },
  );

  log.info(
    { event: "workers_registered" },
    "BullMQ workers registered: fx-refresh (15 6,18 * * *), recurring-gap (0 6 5 * *), health-snapshots (0 3 * * *), slo-alerts (*/30 * * * *), gmail-pull (*/5 * * * *) America/Bogota; classify-tx on-demand",
  );

  // Backfill on boot when the last known rate is stale (source=fallback,
  // never fetched, or fetchedAt > 12h ago). Without this, a fresh deploy or
  // a reboot after a long downtime shows `· fallback` in the Net Worth card
  // until the next scheduled tick lands (#347).
  try {
    const current = await getCurrentFxRate();
    const isStale =
      current.source === "fallback" ||
      current.fetchedAt === null ||
      Date.now() - current.fetchedAt.getTime() > 12 * 60 * 60 * 1000;

    if (isStale) {
      log.info(
        { event: "fx_refresh_boot_backfill", source: current.source, fetchedAt: current.fetchedAt },
        "fx rate stale — enqueueing boot backfill",
      );
      await fxQueue.add(
        "fx-refresh",
        { reason: "boot-backfill" },
        {
          jobId: `fx-refresh-boot-${Date.now()}`,
          attempts: 3,
          backoff: { type: "exponential", delay: 30000 },
        },
      );
    }
  } catch (err) {
    log.error({ err, event: "fx_refresh_boot_check_failed" }, "fx boot backfill check failed");
  }
}
