// #809: Tests for the classify-sweep BullMQ worker processor.
// Unit-style tests — runClassifySweep is mocked. No DB access.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted BEFORE any imports that resolve the modules.
// ---------------------------------------------------------------------------

vi.mock("@/lib/queue", () => ({
  createWorker: vi.fn().mockReturnValue({
    on: vi.fn(),
    close: vi.fn(),
  }),
}));

const mocks = vi.hoisted(() => ({
  runClassifySweep: vi.fn(),
}));

vi.mock("@/lib/classification/sweep", () => ({
  runClassifySweep: mocks.runClassifySweep,
}));

// ---------------------------------------------------------------------------
// Lazy import (after mocks are wired)
// ---------------------------------------------------------------------------

const { classifySweepProcessor } = await import("./classify-sweep");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockJob(): Job {
  return {
    id: "test-job-809",
    updateProgress: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job;
}

const EMPTY_RESULT = {
  usersProcessed: 0,
  totalPicked: 0,
  totalPriorArtClassified: 0,
  totalRuleClassified: 0,
  totalAiClassified: 0,
  totalSettledToOtros: 0,
  categoriesCreated: [],
  perUser: [],
  failedUserIds: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("classifySweepProcessor", () => {
  beforeEach(() => {
    mocks.runClassifySweep.mockReset();
  });

  it("calls runClassifySweep and returns its result", async () => {
    mocks.runClassifySweep.mockResolvedValue(EMPTY_RESULT);

    const result = await classifySweepProcessor(mockJob());

    expect(mocks.runClassifySweep).toHaveBeenCalledOnce();
    expect(result).toEqual(EMPTY_RESULT);
  });

  it("logs one summary line per created category", async () => {
    mocks.runClassifySweep.mockResolvedValue({
      ...EMPTY_RESULT,
      usersProcessed: 1,
      totalAiClassified: 3,
      categoriesCreated: [
        {
          userId: 1,
          slug: "mascotas",
          name: "Mascotas",
          parentSlug: "vivienda",
          supportingTxIds: [10, 11, 12],
          merchantExamples: ["VET CLINIC"],
        },
      ],
    });

    const job = mockJob();
    const result = await classifySweepProcessor(job);

    expect(result.categoriesCreated).toHaveLength(1);
    expect(job.updateProgress).toHaveBeenCalledWith(
      expect.objectContaining({ done: true, categoriesCreated: 1 }),
    );
  });

  it("calls updateProgress at start and done — Bull-Board contract", async () => {
    mocks.runClassifySweep.mockResolvedValue(EMPTY_RESULT);

    const job = mockJob();
    await classifySweepProcessor(job);

    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: "sweeping" }));
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ done: true }));
    expect(job.log).toHaveBeenCalled();
  });

  it("propagates errors for BullMQ retry", async () => {
    mocks.runClassifySweep.mockRejectedValue(new Error("db connection lost"));

    await expect(classifySweepProcessor(mockJob())).rejects.toThrow("db connection lost");
  });

  it("surfaces failedUserIds in the job summary without throwing (#809 WARNING 1)", async () => {
    mocks.runClassifySweep.mockResolvedValue({
      ...EMPTY_RESULT,
      usersProcessed: 1,
      failedUserIds: [42],
    });

    const job = mockJob();
    const result = await classifySweepProcessor(job);

    expect(result.failedUserIds).toEqual([42]);
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ failedUsers: 1 }));
  });
});
