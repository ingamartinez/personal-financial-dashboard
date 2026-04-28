import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { ClassifyTxJobData } from "./classify-tx";

// ---------------------------------------------------------------------------
// Shared mock state via vi.hoisted so factories can access it before imports.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  classifyUnclassifiedBatch: vi.fn(),
  countUnclassified: vi.fn(),
}));

vi.mock("@/lib/classification/pipeline", () => ({
  classifyUnclassifiedBatch: mocks.classifyUnclassifiedBatch,
  AI_BATCH_SIZE: 20,
}));

vi.mock("@/lib/transactions/queries", () => ({
  countUnclassified: mocks.countUnclassified,
}));

const { classifyTxProcessor } = await import("./classify-tx");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(data: ClassifyTxJobData): Job<ClassifyTxJobData> {
  return { id: "test-job-1", data } as unknown as Job<ClassifyTxJobData>;
}

const defaultPipelineResult = {
  picked: 20,
  aiClassified: 15,
  ruleClassified: 3,
  skipped: 2,
  model: "claude-haiku-4-5-20251001",
  usage: { inputTokens: 1000, outputTokens: 200 },
};

// ---------------------------------------------------------------------------
// mode: "specific"
// ---------------------------------------------------------------------------

describe('classifyTxProcessor — mode "specific"', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls classifyUnclassifiedBatch with the given txIds and userId", async () => {
    mocks.classifyUnclassifiedBatch.mockResolvedValueOnce(defaultPipelineResult);

    const txIds = [1, 2, 3, 4, 5];
    await classifyTxProcessor(makeJob({ userId: 42, mode: "specific", txIds }));

    expect(mocks.classifyUnclassifiedBatch).toHaveBeenCalledTimes(1);
    expect(mocks.classifyUnclassifiedBatch).toHaveBeenCalledWith(42, { txIds });
  });

  it("does NOT call countUnclassified in specific mode", async () => {
    mocks.classifyUnclassifiedBatch.mockResolvedValueOnce(defaultPipelineResult);

    await classifyTxProcessor(makeJob({ userId: 1, mode: "specific", txIds: [10] }));

    expect(mocks.countUnclassified).not.toHaveBeenCalled();
  });

  it("completes without error on empty txIds", async () => {
    mocks.classifyUnclassifiedBatch.mockResolvedValueOnce({
      ...defaultPipelineResult,
      picked: 0,
      aiClassified: 0,
      ruleClassified: 0,
      skipped: 0,
    });

    await expect(
      classifyTxProcessor(makeJob({ userId: 1, mode: "specific", txIds: [] })),
    ).resolves.toBeUndefined();
  });

  it("re-throws when classifyUnclassifiedBatch throws", async () => {
    mocks.classifyUnclassifiedBatch.mockRejectedValueOnce(new Error("Anthropic API error"));

    await expect(
      classifyTxProcessor(makeJob({ userId: 1, mode: "specific", txIds: [99] })),
    ).rejects.toThrow("Anthropic API error");
  });
});

// ---------------------------------------------------------------------------
// mode: "drain-pending"
// ---------------------------------------------------------------------------

describe('classifyTxProcessor — mode "drain-pending"', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loops until countUnclassified returns 0", async () => {
    // 3 iterations: 40 pending → 20 pending → 0 pending
    mocks.countUnclassified
      .mockResolvedValueOnce(40)
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(0);
    mocks.classifyUnclassifiedBatch
      .mockResolvedValueOnce(defaultPipelineResult)
      .mockResolvedValueOnce(defaultPipelineResult);

    await classifyTxProcessor(makeJob({ userId: 7, mode: "drain-pending" }));

    expect(mocks.countUnclassified).toHaveBeenCalledTimes(3);
    expect(mocks.classifyUnclassifiedBatch).toHaveBeenCalledTimes(2);
    // drain-pending passes no txIds — falls through to classifyUnclassifiedBatch(userId)
    expect(mocks.classifyUnclassifiedBatch).toHaveBeenCalledWith(7);
  });

  it("exits immediately when pendingCount is already 0", async () => {
    mocks.countUnclassified.mockResolvedValueOnce(0);

    await classifyTxProcessor(makeJob({ userId: 1, mode: "drain-pending" }));

    expect(mocks.classifyUnclassifiedBatch).not.toHaveBeenCalled();
  });

  it("aborts (stall guard) when pipeline picks 0 but count > 0", async () => {
    mocks.countUnclassified.mockResolvedValue(5); // always 5 — would loop forever otherwise
    mocks.classifyUnclassifiedBatch.mockResolvedValueOnce({
      ...defaultPipelineResult,
      picked: 0,
    });

    await expect(
      classifyTxProcessor(makeJob({ userId: 1, mode: "drain-pending" })),
    ).resolves.toBeUndefined();

    // Should have called classifyUnclassifiedBatch once, then hit the stall guard
    expect(mocks.classifyUnclassifiedBatch).toHaveBeenCalledTimes(1);
  });

  it("re-throws when classifyUnclassifiedBatch throws", async () => {
    mocks.countUnclassified.mockResolvedValueOnce(20);
    mocks.classifyUnclassifiedBatch.mockRejectedValueOnce(new Error("timeout"));

    await expect(
      classifyTxProcessor(makeJob({ userId: 1, mode: "drain-pending" })),
    ).rejects.toThrow("timeout");
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation: specific-mode txIds scoped to userId
// ---------------------------------------------------------------------------

describe("tenant isolation — specific mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes userId alongside txIds — pipeline receives both, no cross-tenant leakage", async () => {
    // User A's processor
    mocks.classifyUnclassifiedBatch.mockResolvedValue(defaultPipelineResult);

    const userAId = 100;
    const userBId = 200;
    const userATxIds = [1, 2, 3];
    const userBTxIds = [101, 102];

    await classifyTxProcessor(makeJob({ userId: userAId, mode: "specific", txIds: userATxIds }));
    await classifyTxProcessor(makeJob({ userId: userBId, mode: "specific", txIds: userBTxIds }));

    // Each call should have passed its own userId + txIds
    expect(mocks.classifyUnclassifiedBatch).toHaveBeenNthCalledWith(1, userAId, {
      txIds: userATxIds,
    });
    expect(mocks.classifyUnclassifiedBatch).toHaveBeenNthCalledWith(2, userBId, {
      txIds: userBTxIds,
    });

    // The txIds from user A were never passed with user B's userId
    const allCalls = mocks.classifyUnclassifiedBatch.mock.calls;
    for (const [callUserId, callOpts] of allCalls) {
      if (callUserId === userAId) {
        expect(callOpts?.txIds).toEqual(userATxIds);
      }
      if (callUserId === userBId) {
        expect(callOpts?.txIds).toEqual(userBTxIds);
      }
    }
  });
});
