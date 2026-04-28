// globalThis singleton guards against Turbopack/HMR re-entering registerNode()
// and spawning duplicate cron schedules.
declare global {
  var __findashBgRegistered: boolean | undefined;
}

/**
 * Node-runtime instrumentation body — runs once per worker on boot. Registers:
 * - recurring-gap detector cron (monthly)
 * - per-user health snapshot cron (daily 03:00 America/Bogota)
 * - slo-alerts cron (every 30 min)
 * - fx-refresh BullMQ recurring job (twice daily, 06:15 and 18:15 America/Bogota)
 * - gmail-pull cron (every 5 min)
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

  const cron = (await import("node-cron")).default;
  const { closePreviousMonthForAllUsers } = await import("@/lib/recurring/gap-detector");
  const { snapshotAllActiveUsers } = await import("@/lib/telemetry/user-health");
  const { checkAndAlertSlos } = await import("@/lib/observability/slo-alerts");
  const { getCurrentFxRate } = await import("@/lib/fx/repo");
  const { pullAllActiveConnections } = await import("@/lib/gmail/pull");
  const { createLogger } = await import("@/lib/logger");
  const { createQueue, registerGracefulShutdown } = await import("@/lib/queue");
  const { createFxRefreshWorker } = await import("@/lib/queue/workers/fx-refresh");
  const { createClassifyTxWorker } = await import("@/lib/queue/workers/classify-tx");
  const log = createLogger({ module: "instrumentation" });

  // -------------------------------------------------------------------------
  // BullMQ: fx-refresh worker + recurring schedule
  //
  // jobId is the idempotency key for the repeat entry — without it, every
  // Next.js restart would add another copy of the schedule to Redis.
  // With it, BullMQ deduplicates to exactly one recurring job regardless of
  // how many times registerNode() runs (the globalThis guard above also helps,
  // but jobId is the true safety net at the BullMQ layer).
  // -------------------------------------------------------------------------
  const fxQueue = createQueue("fx-refresh");
  createFxRefreshWorker();

  // classify-tx worker — processes AI classification jobs enqueued by
  // runAiClassifier (server action) and future import pipelines (#591).
  createQueue("classify-tx");
  createClassifyTxWorker();

  registerGracefulShutdown();

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
  cron.schedule(
    "0 6 5 * *",
    async () => {
      try {
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
      } catch (err) {
        log.error(
          { err, event: "recurring_gap_fanout_failed" },
          "recurring-gap detector fan-out failed",
        );
      }
    },
    { timezone: "America/Bogota" },
  );

  // 03:00 COT daily — early enough to be ready before the operator checks
  // /admin/health in the morning, late enough that yesterday's last SMS had
  // time to land.
  cron.schedule(
    "0 3 * * *",
    async () => {
      try {
        const results = await snapshotAllActiveUsers();
        const churned = results.filter((r) => r.ok && r.data.churnSignalFlag).length;
        const failed = results.filter((r) => !r.ok).length;
        log.info(
          { total: results.length, churned, failed, event: "user_health_snapshots_done" },
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
      } catch (err) {
        log.error(
          { err, event: "user_health_fanout_failed" },
          "user-health snapshot fan-out failed",
        );
      }
    },
    { timezone: "America/Bogota" },
  );

  // Every 30 min — evaluate each SLO over a rolling 48h window and fire /
  // resolve Telegram alerts (#329 PR3, #341 wiring). Finer granularity is
  // wasteful: the 48h window swallows sub-half-hour deltas. Dedup is built
  // into `slo_alerts` (at most one unresolved row per sloKey).
  cron.schedule(
    "*/30 * * * *",
    async () => {
      try {
        const decisions = await checkAndAlertSlos();
        const fired = decisions.filter((d) => d.action === "fire").length;
        const resolved = decisions.filter((d) => d.action === "resolve").length;
        const noops = decisions.filter((d) => d.action === "noop").length;
        log.info(
          { total: decisions.length, fired, resolved, noops, event: "slo_alerts_checked" },
          "slo-alerts tick",
        );
      } catch (err) {
        log.error({ err, event: "slo_alerts_check_failed" }, "slo-alerts check failed");
      }
    },
    { timezone: "America/Bogota" },
  );

  // Hourly Gmail enrichment pull (#452, Epic G). Each tick fans out over
  // every active gmail_connections row and pulls new gateway receipts +
  // Bancolombia emails into email_receipts. Per-user failures are logged
  // but do NOT break the loop — one user's revoked token cannot block the
  // others. Manual backfills go through /enriquecer (bot) or
  // POST /api/cron/gmail-pull.
  cron.schedule(
    "*/5 * * * *",
    async () => {
      try {
        const results = await pullAllActiveConnections();
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
          },
          "gmail pull cron tick",
        );
      } catch (err) {
        log.error({ err, event: "gmail_pull_fanout_failed" }, "gmail pull fan-out failed");
      }
    },
    { timezone: "America/Bogota" },
  );

  log.info(
    { event: "crons_registered" },
    "crons registered: recurring-gap (0 6 5 * *), user-health (0 3 * * *), slo-alerts (*/30 * * * *), gmail-pull (*/5 * * * *) America/Bogota; fx-refresh via BullMQ (15 6,18 * * *); classify-tx worker registered",
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
