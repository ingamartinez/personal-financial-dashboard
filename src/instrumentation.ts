// globalThis singleton guards against Turbopack/HMR re-entering register() and
// spawning duplicate long-poll workers or duplicate cron schedules.
declare global {
  var __findashBgRegistered: boolean | undefined;
}

/**
 * Next.js 16 instrumentation hook — runs once per worker on boot. Registers:
 * - recurring-gap detector cron (monthly)
 * - Telegram long-poll worker (if TELEGRAM_BOT_TOKEN is set)
 *
 * Runs only in the Node.js runtime (skipped on Edge). Disable all background
 * work with `FINDASH_DISABLE_CRON=1`; disable only Telegram with
 * `FINDASH_DISABLE_TELEGRAM=1`.
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
  // NOTE: scopes to user 1 pending #185 (multi-user bot + webhook migration).
  // Once that lands, iterate over every active user and run the detector per
  // user id.
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

  if (process.env.FINDASH_DISABLE_TELEGRAM === "1") {
    console.log("[findash] telegram worker disabled via FINDASH_DISABLE_TELEGRAM=1");
    return;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log("[findash] TELEGRAM_BOT_TOKEN not set — telegram worker skipped");
    return;
  }

  const { runPollWorker } = await import("@/lib/telegram/poll-worker");

  // runPollWorker wires its own SIGTERM/SIGINT handlers. Keeping those out of
  // this file avoids Next.js flagging `process.once` during the Edge-runtime
  // static analysis of the instrumentation hook.
  void runPollWorker({
    token,
    allowedUserIds: process.env.TELEGRAM_ALLOWED_USER_IDS,
  }).catch((err) => {
    console.error("[findash] telegram worker crashed:", err);
  });
}
