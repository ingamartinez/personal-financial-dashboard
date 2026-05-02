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
  const { createClassificationAutoUncategorizeWorker } =
    await import("@/lib/queue/workers/classification-auto-uncategorize");
  const { createRecurringLearningWorker } = await import("@/lib/queue/workers/recurring-learning");
  const { createBudgetCheckWorker } = await import("@/lib/queue/workers/budget-check");
  const { createSmsDriftCheckWorker } = await import("@/lib/queue/workers/sms-drift-check");
  const { createRuleProposalsWorker } = await import("@/lib/queue/workers/rule-proposals");
  const { createTcHealthCheckWorker } = await import("@/lib/queue/workers/tc-health-check");
  const { createCashFlowDailyWorker } = await import("@/lib/queue/workers/cash-flow-daily");
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

  // classification-auto-uncategorize: daily at 04:00 COT
  const classificationAutoUncategorizeQueue = createQueue("classification-auto-uncategorize");
  createClassificationAutoUncategorizeWorker();

  // recurring-learning: daily at 04:00 COT (after auto-uncategorize, same window)
  const recurringLearningQueue = createQueue("recurring-learning");
  createRecurringLearningWorker();

  // budget-check: daily at 04:00 COT — after health-snapshots (03:00) and
  // auto-uncategorize (04:00); budget alarms notify once per calendar month.
  const budgetCheckQueue = createQueue("budget-check");
  createBudgetCheckWorker();

  // sms-drift-check: nightly 22:30 COT — detect users with SMS baseline but 0 SMS today
  const smsDriftCheckQueue = createQueue("sms-drift-check");
  createSmsDriftCheckWorker();

  // rule-proposals: daily 05:00 COT — detect correction patterns and propose classification rules
  const ruleProposalsQueue = createQueue("rule-proposals");
  createRuleProposalsWorker();

  // tc-health-check: daily 08:00 COT — cutoff ≤3 days + utilization ≥80/90/95%
  const tcHealthCheckQueue = createQueue("tc-health-check");
  createTcHealthCheckWorker();

  // cash-flow-daily: daily 08:00 COT — D.3 salary-gap + D.4 30d forecast (#715)
  const cashFlowDailyQueue = createQueue("cash-flow-daily");
  createCashFlowDailyWorker();

  // Graceful shutdown is idempotent — safe to call once after all workers are
  // registered.
  registerGracefulShutdown();

  // #505: Auto-mark notifications as read when their underlying event resolves.
  const { registerAutoMarkRead } = await import("@/lib/notifications/auto-mark-read");
  registerAutoMarkRead();

  // #664: Emit gmail_pull_completed notification when a user-triggered Gmail sync finishes.
  const { registerGmailPullCompletionEmitter } =
    await import("@/lib/notifications/gmail-pull-completion");
  registerGmailPullCompletionEmitter();

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

  // 04:00 COT daily — bulk-move stale low-confidence inbox rows (>30d, <60%)
  // to "otros" with user_uncategorized. Null-signal: does NOT feed the learning
  // loop. Same semantics as the user clicking "No me acuerdo" (#628).
  await classificationAutoUncategorizeQueue.add(
    "auto-uncategorize",
    {},
    {
      repeat: { pattern: "0 4 * * *", tz: "America/Bogota" },
      jobId: "classification-auto-uncategorize-recurring",
    },
  );

  // 04:00 COT daily — analyze manual recurring link observations and generate
  // amount-update or variable-flag proposals for the user to review (#633).
  await recurringLearningQueue.add(
    "recurring-learning",
    {},
    {
      repeat: { pattern: "0 4 * * *", tz: "America/Bogota" },
      jobId: "recurring-learning-recurring",
    },
  );

  // 04:00 COT daily — check active budgets vs MTD spend; emit budget_exceeded
  // notification per (user, category, yearMonth). Dedup via entityId partial
  // unique index ensures at most one unread notification per budget per month.
  await budgetCheckQueue.add(
    "budget-check",
    {},
    {
      repeat: { pattern: "0 4 * * *", tz: "America/Bogota" },
      jobId: "budget-check-recurring",
    },
  );

  // 22:30 COT daily — detect users with a 7-day SMS baseline but 0 SMS today.
  // Fires at 22:30 (well within the day) so the alert lands before the user
  // sleeps (#660).
  await smsDriftCheckQueue.add(
    "sms-drift-check",
    {},
    {
      repeat: { pattern: "30 22 * * *", tz: "America/Bogota" },
      jobId: "sms-drift-check-recurring",
    },
  );

  // 05:00 COT daily — scan correction patterns and insert pending rule_proposals;
  // emit rule_proposal_ready notification per inserted proposal (#667).
  await ruleProposalsQueue.add(
    "rule-proposals",
    {},
    {
      repeat: { pattern: "0 5 * * *", tz: "America/Bogota" },
      jobId: "rule-proposals-recurring",
    },
  );

  // 08:00 COT daily — statement cutoff ≤3 days or utilization ≥80/90/95% (#705)
  await tcHealthCheckQueue.add(
    "tc-health-check",
    {},
    {
      repeat: { pattern: "0 8 * * *", tz: "America/Bogota" },
      jobId: "tc-health-check-recurring",
    },
  );

  // 08:00 COT daily — D.3 salary-gap detection + D.4 30d cash flow forecast (#715)
  await cashFlowDailyQueue.add(
    "cash-flow-daily",
    {},
    {
      repeat: { pattern: "0 8 * * *", tz: "America/Bogota" },
      jobId: "cash-flow-daily-recurring",
    },
  );

  log.info(
    { event: "workers_registered" },
    "BullMQ workers registered: fx-refresh (15 6,18 * * *), recurring-gap (0 6 5 * *), health-snapshots (0 3 * * *), slo-alerts (*/30 * * * *), gmail-pull (*/5 * * * *), classification-auto-uncategorize (0 4 * * *), recurring-learning (0 4 * * *), budget-check (0 4 * * *), sms-drift-check (30 22 * * *), rule-proposals (0 5 * * *), tc-health-check (0 8 * * *), cash-flow-daily (0 8 * * *) America/Bogota; classify-tx on-demand",
  );

  // -------------------------------------------------------------------------
  // Bull-Board internal http server
  //
  // Bull-Board's @bull-board/express adapter uses res.render() (EJS) and
  // streaming static-file responses that need a real Node Writable Stream
  // — not the Web Fetch Request/Response pair Next.js Route Handlers
  // expose. So we spin up an internal http.Server on 127.0.0.1:0 (random
  // port) and let the @bull-board/express app handle requests natively.
  // The Next.js route at /api/admin/queues authenticates the user and
  // reverse-proxies via fetch(). See #607, #615.
  // -------------------------------------------------------------------------
  const { getBullBoardApp } = await import("@/lib/queue/bull-board");
  const http = await import("node:http");

  const bullBoardApp = getBullBoardApp();
  const bullBoardServer = http.createServer(bullBoardApp);
  await new Promise<void>((resolve) => {
    bullBoardServer.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = bullBoardServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  (globalThis as unknown as { __findashBullBoardPort?: number }).__findashBullBoardPort = port;
  log.info(
    { event: "bull_board_server_started", port },
    `bull-board internal http server listening on 127.0.0.1:${port}`,
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
