/**
 * Tests for the cash-flow-daily BullMQ worker.
 * The processor is tested directly — no Worker instantiation needed.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoist shared mock references so they work inside vi.mock factories.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  runSalaryGapForUser: vi.fn(),
  runCashFlowForecastForUser: vi.fn(),
  runSavingsSuggestionForUser: vi.fn(),
  getCurrentFxRate: vi.fn(),
  dbExecute: vi.fn(),
}));

vi.mock("@/lib/insights/cash-flow", () => ({
  runSalaryGapForUser: mocks.runSalaryGapForUser,
  runCashFlowForecastForUser: mocks.runCashFlowForecastForUser,
}));

vi.mock("@/lib/insights/savings-suggestions", () => ({
  runSavingsSuggestionForUser: mocks.runSavingsSuggestionForUser,
}));

vi.mock("@/lib/fx/repo", () => ({
  getCurrentFxRate: mocks.getCurrentFxRate,
}));

vi.mock("@/lib/db", () => ({
  db: {
    execute: mocks.dbExecute,
  },
}));

import type { Job } from "bullmq";
import { cashFlowDailyProcessor, type CashFlowDailyJobData } from "./cash-flow-daily";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(data: CashFlowDailyJobData = {}): Job<CashFlowDailyJobData> {
  return {
    id: "test-job-cash-flow-daily",
    data,
    updateProgress: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job<CashFlowDailyJobData>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cashFlowDailyProcessor", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getCurrentFxRate.mockResolvedValue({ rate: 4000, source: "live", fetchedAt: new Date() });
    mocks.runSalaryGapForUser.mockResolvedValue({ gapsEmitted: 0 });
    mocks.runCashFlowForecastForUser.mockResolvedValue({
      forecast: {
        projectedDailyBalance: [],
        minBalance: BigInt(0),
        minBalanceDate: "2026-05-02",
        shortfallDate: undefined,
      },
      shortfallChanged: false,
    });
    mocks.runSavingsSuggestionForUser.mockResolvedValue(undefined);
    // Default: two users
    mocks.dbExecute.mockResolvedValue([{ id: 1 }, { id: 2 }]);
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("calls runSalaryGapForUser and runCashFlowForecastForUser for each user", async () => {
    await cashFlowDailyProcessor(makeJob());

    expect(mocks.runSalaryGapForUser).toHaveBeenCalledTimes(2);
    expect(mocks.runCashFlowForecastForUser).toHaveBeenCalledTimes(2);
    expect(mocks.runSalaryGapForUser).toHaveBeenCalledWith(1, expect.anything(), expect.any(Date));
    expect(mocks.runSalaryGapForUser).toHaveBeenCalledWith(2, expect.anything(), expect.any(Date));
  });

  it("calls updateProgress at start and done — Bull-Board contract", async () => {
    const job = makeJob();
    await cashFlowDailyProcessor(job);

    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ users: 0 }));
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ done: true }));
    expect(job.log).toHaveBeenCalled();
  });

  it("handles empty user list (no active users) without error", async () => {
    mocks.dbExecute.mockResolvedValue([]);

    const job = makeJob();
    await expect(cashFlowDailyProcessor(job)).resolves.toBeUndefined();

    expect(mocks.runSalaryGapForUser).not.toHaveBeenCalled();
    expect(mocks.runCashFlowForecastForUser).not.toHaveBeenCalled();
  });

  it("logs per-user errors without throwing (fan-out resilience)", async () => {
    mocks.runSalaryGapForUser.mockRejectedValueOnce(new Error("user 1 salary gap failed"));

    const job = makeJob();
    // Should NOT throw — per-user errors are logged, not re-thrown.
    await expect(cashFlowDailyProcessor(job)).resolves.toBeUndefined();

    // User 2 should still be processed
    expect(mocks.runCashFlowForecastForUser).toHaveBeenCalledWith(
      2,
      expect.any(Number),
      expect.anything(),
      expect.any(Date),
    );
  });

  it("propagates top-level errors (e.g. DB down) for BullMQ retry", async () => {
    mocks.dbExecute.mockRejectedValueOnce(new Error("DB connection lost"));

    await expect(cashFlowDailyProcessor(makeJob())).rejects.toThrow("DB connection lost");
  });

  it("passes the FX rate to runCashFlowForecastForUser", async () => {
    mocks.getCurrentFxRate.mockResolvedValue({ rate: 4200, source: "live", fetchedAt: new Date() });
    mocks.dbExecute.mockResolvedValue([{ id: 1 }]);

    await cashFlowDailyProcessor(makeJob());

    expect(mocks.runCashFlowForecastForUser).toHaveBeenCalledWith(
      1,
      4200,
      expect.anything(),
      expect.any(Date),
    );
  });

  it("accumulates gaps from multiple users", async () => {
    mocks.runSalaryGapForUser
      .mockResolvedValueOnce({ gapsEmitted: 2 })
      .mockResolvedValueOnce({ gapsEmitted: 1 });

    const job = makeJob();
    await cashFlowDailyProcessor(job);

    expect(job.updateProgress).toHaveBeenCalledWith(
      expect.objectContaining({ gapsTotal: 3, done: true }),
    );
  });

  it("fires runSavingsSuggestionForUser for each user (fire-and-forget hook)", async () => {
    mocks.dbExecute.mockResolvedValue([{ id: 1 }, { id: 2 }]);

    await cashFlowDailyProcessor(makeJob());

    // Hook is fire-and-forget so we wait a tick for the promise to resolve
    await Promise.resolve();

    expect(mocks.runSavingsSuggestionForUser).toHaveBeenCalledTimes(2);
    expect(mocks.runSavingsSuggestionForUser).toHaveBeenCalledWith(1, expect.anything(), 4000);
    expect(mocks.runSavingsSuggestionForUser).toHaveBeenCalledWith(2, expect.anything(), 4000);
  });

  it("does not throw when runSavingsSuggestionForUser rejects (fire-and-forget)", async () => {
    mocks.dbExecute.mockResolvedValue([{ id: 1 }]);
    mocks.runSavingsSuggestionForUser.mockRejectedValueOnce(new Error("savings check failed"));

    const job = makeJob();
    // The rejection is caught internally — processor must NOT throw
    await expect(cashFlowDailyProcessor(job)).resolves.toBeUndefined();
  });
});
