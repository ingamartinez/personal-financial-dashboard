import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { ClassifyTxJobData } from "./classify-tx";

// ---------------------------------------------------------------------------
// Shared mock state via vi.hoisted so factories can access it before imports.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  classifyUnclassifiedBatch: vi.fn(),
  countUnclassified: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("@/lib/classification/pipeline", () => ({
  classifyUnclassifiedBatch: mocks.classifyUnclassifiedBatch,
  AI_BATCH_SIZE: 20,
}));

vi.mock("@/lib/transactions/queries", () => ({
  countUnclassified: mocks.countUnclassified,
}));

vi.mock("@/lib/events/bus", () => ({
  emit: mocks.emit,
}));

const { classifyTxProcessor } = await import("./classify-tx");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(data: ClassifyTxJobData): Job<ClassifyTxJobData> {
  return {
    id: "test-job-1",
    data,
    updateProgress: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job<ClassifyTxJobData>;
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
// Bull-Board contract: updateProgress called at start and done
// ---------------------------------------------------------------------------

describe("Bull-Board contract — updateProgress + log", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("specific mode: calls updateProgress at start and done", async () => {
    mocks.classifyUnclassifiedBatch.mockResolvedValueOnce(defaultPipelineResult);

    const job = makeJob({ userId: 1, mode: "specific", txIds: [10, 11] });
    await classifyTxProcessor(job);

    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ mode: "specific" }));
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ done: true }));
    expect(job.log).toHaveBeenCalled();
  });

  it("drain-pending mode: calls updateProgress at start and done", async () => {
    mocks.countUnclassified.mockResolvedValueOnce(20).mockResolvedValueOnce(0);
    mocks.classifyUnclassifiedBatch.mockResolvedValueOnce(defaultPipelineResult);

    const job = makeJob({ userId: 1, mode: "drain-pending" });
    await classifyTxProcessor(job);

    expect(job.updateProgress).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "drain-pending" }),
    );
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ done: true }));
    expect(job.log).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation: specific-mode txIds scoped to userId
// ---------------------------------------------------------------------------

// Worker-level tenant isolation: this test verifies the WORKER routes each
// job's userId correctly through to the pipeline. The actual DB-level
// isolation guarantee (cross-tenant txIds rejected by the WHERE clause)
// is covered in pipeline.test.ts under "tenant isolation" — that one runs
// against the real findash_test DB.
describe("tenant isolation — specific mode (call-routing only)", () => {
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

// ---------------------------------------------------------------------------
// Bus emit — drain-pending emits job:progress + job:done; specific does NOT
// ---------------------------------------------------------------------------

describe("bus emit — drain-pending mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits job:progress after each batch and job:done on completion", async () => {
    // 2 iterations: 40 pending → 20 pending → 0 pending
    mocks.countUnclassified
      .mockResolvedValueOnce(40)
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(0);
    mocks.classifyUnclassifiedBatch
      .mockResolvedValueOnce({
        ...defaultPipelineResult,
        aiClassified: 10,
        ruleClassified: 5,
        skipped: 5,
      })
      .mockResolvedValueOnce(defaultPipelineResult);

    await classifyTxProcessor(makeJob({ userId: 7, mode: "drain-pending" }));

    const progressCalls = mocks.emit.mock.calls.filter(
      (args) => (args[0] as { type: string }).type === "job:progress",
    );
    const doneCalls = mocks.emit.mock.calls.filter(
      (args) => (args[0] as { type: string }).type === "job:done",
    );

    // One progress per batch iteration (2 iterations), one done at the end.
    expect(progressCalls).toHaveLength(2);
    expect(doneCalls).toHaveLength(1);

    // First progress: after first batch (10+5=15 processed, total=40, pending=40)
    expect(progressCalls[0][0]).toMatchObject({
      type: "job:progress",
      jobName: "classify-tx",
      jobId: "test-job-1",
      userId: 7,
      processed: 15,
      total: 40,
    });

    // Done event: classifiedCount = all ai+rule classified
    expect(doneCalls[0][0]).toMatchObject({
      type: "job:done",
      jobName: "classify-tx",
      jobId: "test-job-1",
      userId: 7,
    });
    const doneEvent = doneCalls[0][0] as { classifiedCount: number; skippedCount: number };
    expect(typeof doneEvent.classifiedCount).toBe("number");
    expect(typeof doneEvent.skippedCount).toBe("number");
  });

  it("emits job:done immediately when pendingCount is already 0", async () => {
    mocks.countUnclassified.mockResolvedValueOnce(0);

    await classifyTxProcessor(makeJob({ userId: 1, mode: "drain-pending" }));

    const doneCalls = mocks.emit.mock.calls.filter(
      (args) => (args[0] as { type: string }).type === "job:done",
    );
    expect(doneCalls).toHaveLength(1);
    expect(doneCalls[0][0]).toMatchObject({
      type: "job:done",
      jobName: "classify-tx",
      userId: 1,
      classifiedCount: 0,
      skippedCount: 0,
    });

    const progressCalls = mocks.emit.mock.calls.filter(
      (args) => (args[0] as { type: string }).type === "job:progress",
    );
    expect(progressCalls).toHaveLength(0);
  });

  it("emits job:done on stall guard exit", async () => {
    mocks.countUnclassified.mockResolvedValue(5);
    mocks.classifyUnclassifiedBatch.mockResolvedValueOnce({
      ...defaultPipelineResult,
      picked: 0,
    });

    await classifyTxProcessor(makeJob({ userId: 1, mode: "drain-pending" }));

    const doneCalls = mocks.emit.mock.calls.filter(
      (args) => (args[0] as { type: string }).type === "job:done",
    );
    expect(doneCalls).toHaveLength(1);
    expect(doneCalls[0][0].type).toBe("job:done");
    expect(doneCalls[0][0].jobName).toBe("classify-tx");
  });
});

describe("bus emit — specific mode does NOT emit job:* events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not emit any bus events in specific mode", async () => {
    mocks.classifyUnclassifiedBatch.mockResolvedValueOnce(defaultPipelineResult);

    await classifyTxProcessor(makeJob({ userId: 1, mode: "specific", txIds: [10, 11] }));

    const jobEvents = mocks.emit.mock.calls.filter((args) =>
      (args[0] as { type: string }).type.startsWith("job:"),
    );
    expect(jobEvents).toHaveLength(0);
  });
});
