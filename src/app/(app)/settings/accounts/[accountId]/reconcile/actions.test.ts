import { describe, expect, it } from "vitest";

const { expandReconcileWindow } = await import("./window");

describe("expandReconcileWindow (#543)", () => {
  it("expands the period boundary by the match-engine tolerance on both sides", () => {
    // periodEnd at midnight Bogotá of 2026-04-26 = 2026-04-26T05:00:00Z
    const periodStart = new Date("2026-04-01T05:00:00Z");
    const periodEnd = new Date("2026-04-26T05:00:00Z");
    const { windowStart, windowEnd } = expandReconcileWindow(periodStart, periodEnd);
    // 3 days of slack matches DEFAULT_DATE_TOLERANCE_DAYS in match.ts
    expect(windowStart.toISOString()).toBe("2026-03-29T05:00:00.000Z");
    expect(windowEnd.toISOString()).toBe("2026-04-29T05:00:00.000Z");
  });

  it("a Gmail-captured tx at 21:33 Bogotá the same day as periodEnd falls inside the window", () => {
    // periodEnd from XLSX = midnight Bogotá of 2026-04-26
    const periodEnd = new Date("2026-04-26T05:00:00Z");
    // Gmail tx recorded at 21:33 Bogotá of 2026-04-26 (= 02:33 UTC of 2026-04-27)
    const gmailTx = new Date("2026-04-27T02:33:00Z");
    // Without the fix this assertion would have failed: gmailTx > periodEnd in UTC
    expect(gmailTx.getTime() > periodEnd.getTime()).toBe(true);
    const { windowEnd } = expandReconcileWindow(new Date("2026-04-01T05:00:00Z"), periodEnd);
    expect(gmailTx.getTime() <= windowEnd.getTime()).toBe(true);
  });
});
