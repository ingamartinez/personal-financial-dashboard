// globalThis singleton guards against Turbopack/HMR re-entering register() and
// spawning duplicate cron schedules.
declare global {
  var __findashBgRegistered: boolean | undefined;
}

/**
 * Next.js 16 instrumentation hook — runs once per worker on boot. Registers:
 * - recurring-gap detector cron (monthly)
 *
 * Telegram used to run a long-poll worker here; #185 moved that to per-user
 * webhooks (`src/app/api/telegram/webhook/[botId]/route.ts`) so there is no
 * background worker to wire up anymore.
 *
 * Runs only in the Node.js runtime (skipped on Edge). Disable all background
 * work with `FINDASH_DISABLE_CRON=1`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.FINDASH_DISABLE_CRON === "1") return;
  if (globalThis.__findashBgRegistered) return;
  globalThis.__findashBgRegistered = true;

  const cron = (await import("node-cron")).default;
  const { closePreviousMonth } = await import("@/lib/recurring/gap-detector");

  // Day 5 of each month at 06:00 America/Bogota — gives a 4-day grace window
  // for late-posting SMS/Apple Pay events before we finalize gaps.
  // NOTE: scopes to user 1. Iterating all active users is tracked separately
  // from #185 — the hardcode survives this PR on purpose.
  cron.schedule(
    "0 6 5 * *",
    async () => {
      try {
        const result = await closePreviousMonth(1);
        console.log(
          `[findash] recurring-gap detector closed ${result.yearMonth}:`,
          JSON.stringify(result),
        );
      } catch (err) {
        console.error("[findash] recurring-gap detector failed:", err);
      }
    },
    { timezone: "America/Bogota" },
  );

  console.log("[findash] recurring-gap cron registered (0 6 5 * * America/Bogota)");
}
