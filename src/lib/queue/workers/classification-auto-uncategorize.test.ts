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
  emitNotification: vi.fn(),
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

vi.mock("@/lib/notifications/emit", () => ({
  emitNotification: mocks.emitNotification,
}));

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
    id: "id",
    userId: "user_id",
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

    // Default: emitNotification resolves successfully.
    mocks.emitNotification.mockResolvedValue({ id: 999 });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("calls db.update with the correct set values", async () => {
    mocks.dbUpdateSetWhereReturning.mockResolvedValueOnce([
      { id: 1, userId: 10 },
      { id: 2, userId: 10 },
    ]);

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
    mocks.dbUpdateSetWhereReturning.mockResolvedValueOnce([
      { id: 10, userId: 1 },
      { id: 20, userId: 2 },
      { id: 30, userId: 2 },
    ]);

    const result = await classificationAutoUncategorizeProcessor(makeJob());

    expect(result).toEqual({ rowsUpdated: 3 });
  });

  it("returns rowsUpdated=0 when no rows match and does NOT emit", async () => {
    mocks.dbUpdateSetWhereReturning.mockResolvedValueOnce([]);

    const result = await classificationAutoUncategorizeProcessor(makeJob());

    expect(result).toEqual({ rowsUpdated: 0 });
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("logs a completion event with rowsUpdated", async () => {
    mocks.dbUpdateSetWhereReturning.mockResolvedValueOnce([{ id: 5, userId: 42 }]);

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
    mocks.dbUpdateSetWhereReturning.mockResolvedValueOnce([
      { id: 1, userId: 10 },
      { id: 2, userId: 10 },
    ]);

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

  // ── New: notification emitter tests ─────────────────────────────────────

  it("emits one notification per distinct userId when rows are affected", async () => {
    // 3 rows: userA gets 2 txs, userB gets 1 tx.
    mocks.dbUpdateSetWhereReturning.mockResolvedValueOnce([
      { id: 1, userId: 100 },
      { id: 2, userId: 100 },
      { id: 3, userId: 200 },
    ]);

    await classificationAutoUncategorizeProcessor(makeJob());

    // Should emit exactly 2 notifications, one per user.
    expect(mocks.emitNotification).toHaveBeenCalledTimes(2);
  });

  it("emits with correct type and entityId for each userId", async () => {
    const todayBogota = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/Bogota",
    });

    mocks.dbUpdateSetWhereReturning.mockResolvedValueOnce([{ id: 1, userId: 42 }]);

    await classificationAutoUncategorizeProcessor(makeJob());

    expect(mocks.emitNotification).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        type: "classification_auto_uncategorized",
        entityId: `auto-uncat-42-${todayBogota}`,
        priority: "medium",
      }),
    );
  });

  it("emits correct batchSize in metadata per user", async () => {
    // userId 10 → 3 txs, userId 20 → 1 tx.
    mocks.dbUpdateSetWhereReturning.mockResolvedValueOnce([
      { id: 1, userId: 10 },
      { id: 2, userId: 10 },
      { id: 3, userId: 10 },
      { id: 4, userId: 20 },
    ]);

    await classificationAutoUncategorizeProcessor(makeJob());

    const callsForUser10 = mocks.emitNotification.mock.calls.filter(
      (args: unknown[]) => args[0] === 10,
    );
    const callsForUser20 = mocks.emitNotification.mock.calls.filter(
      (args: unknown[]) => args[0] === 20,
    );

    expect((callsForUser10[0][1] as { metadata: { batchSize: number } }).metadata.batchSize).toBe(
      3,
    );
    expect((callsForUser20[0][1] as { metadata: { batchSize: number } }).metadata.batchSize).toBe(
      1,
    );
  });

  it("dedup: same entityId on second run — emitNotification called but idempotent dedup is in emit.ts", async () => {
    // entityId is stable by (userId, date) — the dedup happens inside emitNotification
    // via the DB unique index. Here we just verify the entityId is the same across calls.
    const todayBogota = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/Bogota",
    });

    mocks.dbUpdateSetWhereReturning.mockResolvedValue([{ id: 1, userId: 77 }]);

    await classificationAutoUncategorizeProcessor(makeJob());
    await classificationAutoUncategorizeProcessor(makeJob());

    const entityIds = mocks.emitNotification.mock.calls.map(
      (args: unknown[]) => (args[1] as { entityId: string }).entityId,
    );
    // Both calls use the same entityId.
    expect(entityIds).toEqual([`auto-uncat-77-${todayBogota}`, `auto-uncat-77-${todayBogota}`]);
  });

  it("tenant safety: each userId gets its own emit, not mixed", async () => {
    // Users A=1, B=2, C=3 — each with different counts.
    mocks.dbUpdateSetWhereReturning.mockResolvedValueOnce([
      { id: 1, userId: 1 },
      { id: 2, userId: 2 },
      { id: 3, userId: 3 },
      { id: 4, userId: 1 }, // userA gets a second tx
    ]);

    await classificationAutoUncategorizeProcessor(makeJob());

    type EmitCall = [number, { metadata: { batchSize: number } }];
    const calls = mocks.emitNotification.mock.calls as EmitCall[];
    const userIds = calls.map((c) => c[0]).sort();
    expect(userIds).toEqual([1, 2, 3]);

    const user1Call = calls.find((c) => c[0] === 1);
    expect(user1Call?.[1].metadata.batchSize).toBe(2);

    const user2Call = calls.find((c) => c[0] === 2);
    expect(user2Call?.[1].metadata.batchSize).toBe(1);
  });

  it("emits actionUrl pointing to /transactions?categorySlug=otros", async () => {
    mocks.dbUpdateSetWhereReturning.mockResolvedValueOnce([{ id: 1, userId: 5 }]);

    await classificationAutoUncategorizeProcessor(makeJob());

    expect(mocks.emitNotification).toHaveBeenCalledWith(
      5,
      expect.objectContaining({
        actionUrl: "/transactions?categorySlug=otros",
      }),
    );
  });
});
