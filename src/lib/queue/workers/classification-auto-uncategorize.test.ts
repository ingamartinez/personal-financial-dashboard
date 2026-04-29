// Tests for the classification-auto-uncategorize BullMQ worker.
// The processor is tested directly — no Worker instantiation needed for unit tests.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoist shared mock references so they work inside vi.mock factories.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  dbUpdate: vi.fn(),
  dbUpdateSet: vi.fn(),
  dbUpdateSetWhere: vi.fn(),
  dbUpdateSetWhereReturning: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

// Mock the db module — intercept the update call and capture the where clause.
vi.mock("@/lib/db", () => {
  const returningFn = mocks.dbUpdateSetWhereReturning;
  const whereFn = mocks.dbUpdateSetWhere.mockReturnValue({ returning: returningFn });
  const setFn = mocks.dbUpdateSet.mockReturnValue({ where: whereFn });
  const updateFn = mocks.dbUpdate.mockReturnValue({ set: setFn });
  return {
    db: {
      update: updateFn,
    },
  };
});

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: mocks.logInfo,
    error: mocks.logError,
  }),
}));

// We don't need real schema values — the mock intercepts before DB touches them.
vi.mock("@/lib/db/schema", () => ({
  transactions: {
    classificationMethod: "classification_method",
    classificationConfidence: "classification_confidence",
    occurredAt: "occurred_at",
    deletedAt: "deleted_at",
  },
}));

import type { Job } from "bullmq";
import {
  classificationAutoUncategorizeProcessor,
  type ClassificationAutoUncategorizeJobData,
} from "./classification-auto-uncategorize";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(
  data: ClassificationAutoUncategorizeJobData = {},
): Job<ClassificationAutoUncategorizeJobData> {
  return {
    id: "test-job-auto-uncat",
    data,
    updateProgress: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job<ClassificationAutoUncategorizeJobData>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("classificationAutoUncategorizeProcessor", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Re-wire the mock chain after reset since resetAllMocks clears return values.
    const returningFn = mocks.dbUpdateSetWhereReturning;
    const whereFn = mocks.dbUpdateSetWhere.mockReturnValue({ returning: returningFn });
    const setFn = mocks.dbUpdateSet.mockReturnValue({ where: whereFn });
    mocks.dbUpdate.mockReturnValue({ set: setFn });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("calls db.update with the correct set values", async () => {
    mocks.dbUpdateSetWhereReturning.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);

    await classificationAutoUncategorizeProcessor(makeJob());

    expect(mocks.dbUpdate).toHaveBeenCalledOnce();
    expect(mocks.dbUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        categorySlug: "otros",
        classificationMethod: "user_uncategorized",
        classificationConfidence: 100,
      }),
    );
  });

  it("returns rowsUpdated equal to the number of affected rows", async () => {
    mocks.dbUpdateSetWhereReturning.mockResolvedValueOnce([{ id: 10 }, { id: 20 }, { id: 30 }]);

    const result = await classificationAutoUncategorizeProcessor(makeJob());

    expect(result).toEqual({ rowsUpdated: 3 });
  });

  it("returns rowsUpdated=0 when no rows match", async () => {
    mocks.dbUpdateSetWhereReturning.mockResolvedValueOnce([]);

    const result = await classificationAutoUncategorizeProcessor(makeJob());

    expect(result).toEqual({ rowsUpdated: 0 });
  });

  it("logs a completion event with rowsUpdated", async () => {
    mocks.dbUpdateSetWhereReturning.mockResolvedValueOnce([{ id: 5 }]);

    await classificationAutoUncategorizeProcessor(makeJob());

    expect(mocks.logInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "auto_uncategorize_completed",
        rowsUpdated: 1,
      }),
      expect.any(String),
    );
  });

  it("propagates db errors for BullMQ retry", async () => {
    mocks.dbUpdateSetWhereReturning.mockRejectedValueOnce(new Error("db connection lost"));

    await expect(classificationAutoUncategorizeProcessor(makeJob())).rejects.toThrow(
      "db connection lost",
    );
  });

  it("calls updateProgress at start and done — Bull-Board contract", async () => {
    mocks.dbUpdateSetWhereReturning.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);

    const job = makeJob();
    await classificationAutoUncategorizeProcessor(job);

    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ users: 0 }));
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ done: true }));
    expect(job.log).toHaveBeenCalled();
  });

  it("stores the correct classificationReason JSON in the set call", async () => {
    mocks.dbUpdateSetWhereReturning.mockResolvedValueOnce([]);

    await classificationAutoUncategorizeProcessor(makeJob());

    const setCall = mocks.dbUpdateSet.mock.calls[0][0];
    const reason = JSON.parse(setCall.classificationReason as string);
    expect(reason).toMatchObject({
      action: "auto_uncategorized",
      reason: "30d_inbox_stragglers",
    });
  });
});
