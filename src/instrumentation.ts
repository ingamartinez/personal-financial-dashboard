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

  // Day 5 of each month at 06:00 America/Bogota — gives a 4-day grace window
  // for late-posting SMS/Apple Pay events before we finalize gaps.
  cron.schedule(
    "0 6 5 * *",
    async () => {
      try {
        const results = await closePreviousMonthForAllUsers();
        for (const entry of results) {
          if (entry.ok) {
            console.log(
              `[findash] recurring-gap detector closed ${entry.result.yearMonth} for user ${entry.userId}:`,
              JSON.stringify(entry.result),
            );
          } else {
            console.error(
              `[findash] recurring-gap detector failed for user ${entry.userId}:`,
              entry.error,
            );
          }
        }
      } catch (err) {
        console.error("[findash] recurring-gap detector fan-out failed:", err);
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
        console.log(
          `[findash] user-health snapshots: ${results.length} users, ${churned} churn flags, ${failed} failures`,
        );
        for (const entry of results) {
          if (!entry.ok) {
            console.error(
              `[findash] user-health snapshot failed for user ${entry.userId}:`,
              entry.error,
            );
          }
        }
      } catch (err) {
        console.error("[findash] user-health snapshot fan-out failed:", err);
      }
    },
    { timezone: "America/Bogota" },
  );

  console.log(
    "[findash] crons registered: recurring-gap (0 6 5 * *), user-health (0 3 * * *) America/Bogota",
  );
}
