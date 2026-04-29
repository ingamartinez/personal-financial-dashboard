// Tests for the recurring-gap BullMQ worker.
// The processor is tested directly — no Worker instantiation needed for unit tests.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoist shared mock references so they work inside vi.mock factories.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  closePreviousMonthForAllUsers: vi.fn(),
}));

vi.mock("@/lib/recurring/gap-detector", () => ({
  closePreviousMonthForAllUsers: mocks.closePreviousMonthForAllUsers,
}));

import type { Job } from "bullmq";
import { recurringGapProcessor, type RecurringGapJobData } from "./recurring-gap";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(data: RecurringGapJobData = {}): Job<RecurringGapJobData> {
  return {
    id: "test-job-recurring-gap",
    data,
    updateProgress: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job<RecurringGapJobData>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("recurringGapProcessor", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("calls closePreviousMonthForAllUsers and logs results", async () => {
    mocks.closePreviousMonthForAllUsers.mockResolvedValueOnce([
      { ok: true, userId: 1, result: { yearMonth: "2026-03" } },
      { ok: true, userId: 2, result: { yearMonth: "2026-03" } },
    ]);

    await recurringGapProcessor(makeJob());

    expect(mocks.closePreviousMonthForAllUsers).toHaveBeenCalledOnce();
  });

  it("logs per-user errors without throwing", async () => {
    mocks.closePreviousMonthForAllUsers.mockResolvedValueOnce([
      { ok: true, userId: 1, result: { yearMonth: "2026-03" } },
      { ok: false, userId: 2, error: new Error("DB error") },
    ]);

    // Should NOT throw — per-user errors are logged, not re-thrown.
    await expect(recurringGapProcessor(makeJob())).resolves.toBeUndefined();
  });

  it("propagates top-level closePreviousMonthForAllUsers errors for BullMQ retry", async () => {
    mocks.closePreviousMonthForAllUsers.mockRejectedValueOnce(new Error("DB connection lost"));

    await expect(recurringGapProcessor(makeJob())).rejects.toThrow("DB connection lost");
  });

  it("handles empty results (no active users) without error", async () => {
    mocks.closePreviousMonthForAllUsers.mockResolvedValueOnce([]);

    await expect(recurringGapProcessor(makeJob())).resolves.toBeUndefined();
    expect(mocks.closePreviousMonthForAllUsers).toHaveBeenCalledOnce();
  });

  it("calls updateProgress at start and done — Bull-Board contract", async () => {
    mocks.closePreviousMonthForAllUsers.mockResolvedValueOnce([
      { ok: true, userId: 1, result: { yearMonth: "2026-03" } },
    ]);

    const job = makeJob();
    await recurringGapProcessor(job);

    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ users: 0 }));
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ done: true }));
    expect(job.log).toHaveBeenCalled();
  });
});
