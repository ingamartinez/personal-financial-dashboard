// Unit test for Wave 3 insights_report_ready emitter (#662).
// Spies on emitNotification and verifies it is called once after
// generateInsight successfully inserts a report.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as emitModule from "@/lib/notifications/emit";

// ── module mocks ──────────────────────────────────────────────────────────

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const sessionMock = { id: 3, email: "test@test.local", name: "Test" };
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn().mockImplementation(async () => sessionMock),
}));

vi.mock("@/lib/fx/repo", () => ({
  getCurrentFxRate: vi.fn().mockResolvedValue({ rate: 4200 }),
}));

vi.mock("@/lib/dashboard/period", () => ({
  getFinancialPeriod: vi.fn().mockResolvedValue({
    start: new Date("2026-04-01"),
    end: new Date("2026-04-30"),
  }),
}));

vi.mock("@/lib/preferences/repo", () => ({
  getUiPreferences: vi.fn().mockResolvedValue({
    displayCurrencyMode: "native",
    financialCycleMode: "calendar",
    payPeriodNudgeDismissed: false,
  }),
}));

vi.mock("@/lib/ai/insights", () => ({
  buildInsightsSummary: vi.fn().mockResolvedValue({ summary: "mock" }),
  generateInsightsReport: vi.fn().mockResolvedValue({
    markdown: "# Insights\n...",
    model: "claude-haiku-4",
    usage: { inputTokens: 100, outputTokens: 200 },
  }),
  hashSummary: vi.fn().mockReturnValue("abc123"),
}));

vi.mock("@/lib/db", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue([]),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
  },
}));

// ── tests ─────────────────────────────────────────────────────────────────

describe("generateInsight — insights_report_ready emitter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits insights_report_ready once with correct shape", async () => {
    const spy = vi.spyOn(emitModule, "emitNotification").mockResolvedValue({ id: 999 });

    const { generateInsight } = await import("./actions");
    const result = await generateInsight("2026-04");

    expect(result.ym).toBe("2026-04");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      sessionMock.id,
      expect.objectContaining({
        type: "insights_report_ready",
        entityId: "2026-04",
        priority: "low",
        title: "Reporte de insights listo",
        actionUrl: "/insights?yearMonth=2026-04",
      }),
    );
    expect(spy.mock.calls[0]![1].metadata).toMatchObject({ yearMonth: "2026-04" });
  });

  it("does NOT emit when yearMonth schema validation fails", async () => {
    const spy = vi.spyOn(emitModule, "emitNotification").mockResolvedValue({ id: 999 });

    const { generateInsight } = await import("./actions");
    await expect(generateInsight("invalid")).rejects.toThrow();

    expect(spy).not.toHaveBeenCalled();
  });
});
