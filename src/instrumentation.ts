// globalThis singleton guards against Turbopack/HMR re-entering register() and
// spawning duplicate cron schedules.
declare global {
  var __findashBgRegistered: boolean | undefined;
}

/**
 * Next.js 16 instrumentation hook — runs once per worker on boot. Registers:
 * - recurring-gap detector cron (monthly)
 * - per-user health snapshot cron (daily 03:00 America/Bogota)
 *
 * Telegram used to run a long-poll worker here; #185 moved it to per-user
 * webhooks (`src/app/api/telegram/webhook/[botId]/route.ts`) so there is no
 * background worker to wire up anymore.
 *
 * Runs only in the Node.js runtime (skipped on Edge). Disable all crons with
 * `FINDASH_DISABLE_CRON=1`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.FINDASH_DISABLE_CRON === "1") return;
  if (globalThis.__findashBgRegistered) return;
  globalThis.__findashBgRegistered = true;

  const cron = (await import("node-cron")).default;
  const { closePreviousMonthForAllUsers } = await import("@/lib/recurring/gap-detector");
  const { snapshotAllActiveUsers } = await import("@/lib/telemetry/user-health");
  const { createLogger } = await import("@/lib/logger");
  const log = createLogger({ module: "instrumentation" });

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

  log.info(
    { event: "crons_registered" },
    "crons registered: recurring-gap (0 6 5 * *), user-health (0 3 * * *) America/Bogota",
  );
}
