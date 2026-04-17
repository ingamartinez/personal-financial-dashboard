/**
 * Next.js 16 instrumentation hook — runs once per worker on boot. Used here
 * to register the recurring-gap detector cron. Runs only in the Node.js
 * runtime (skipped on Edge) and can be disabled entirely via
 * `FINDASH_DISABLE_CRON=1` for tests or one-shot scripts.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.FINDASH_DISABLE_CRON === "1") return;

  const cron = (await import("node-cron")).default;
  const { closePreviousMonth } = await import("@/lib/recurring/gap-detector");

  // Day 5 of each month at 06:00 America/Bogota — gives a 4-day grace window
  // for late-posting SMS/Apple Pay events before we finalize gaps.
  cron.schedule(
    "0 6 5 * *",
    async () => {
      try {
        const result = await closePreviousMonth();
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
