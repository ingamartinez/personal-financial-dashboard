import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock hoisting — factories must be inside vi.mock() callbacks;
// shared state is threaded through vi.hoisted().
// ---------------------------------------------------------------------------

const { mockQueueAdd, mockSelectWhere, mockUpdateWhere, mockClassifyByRule } = vi.hoisted(() => ({
  mockQueueAdd: vi.fn(),
  mockSelectWhere: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockClassifyByRule: vi.fn(),
}));

const { mockLogInfo, mockLogWarn, mockLogError } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock("@/lib/queue", () => ({
  createQueue: vi.fn(() => ({ add: mockQueueAdd })),
}));

vi.mock("@/lib/classification/rules", () => ({
  classifyByRule: mockClassifyByRule,
}));

// Minimal db mock with overrideable where resolvers.
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: mockSelectWhere,
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: mockUpdateWhere,
      })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  transactions: {
    id: "id",
    descriptionRaw: "descriptionRaw",
    merchant: "merchant",
    categorySlug: "categorySlug",
    classificationMethod: "classificationMethod",
    classificationConfidence: "classificationConfidence",
    updatedAt: "updatedAt",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...preds) => ({ and: preds })),
  eq: vi.fn((_col, val) => ({ eq: val })),
  inArray: vi.fn((_col, vals) => ({ inArray: vals })),
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
  }),
}));

import {
  enqueueClassification,
  classifyByRuleThenEnqueue,
  enqueueAskUser,
  DEFAULT_ENQUEUE_TIMEOUT_MS,
} from "./enqueue";

beforeEach(() => {
  mockLogInfo.mockReset();
  mockLogWarn.mockReset();
  mockLogError.mockReset();
});

// ---------------------------------------------------------------------------
// enqueueClassification
// ---------------------------------------------------------------------------

describe("enqueueClassification", () => {
  beforeEach(() => {
    mockQueueAdd.mockReset();
  });

  it("does nothing when txIds is empty", async () => {
    await enqueueClassification(1, []);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("calls queue.add with correct payload on happy path", async () => {
    mockQueueAdd.mockResolvedValueOnce({ id: "job-1" });
    await enqueueClassification(42, [101, 102, 103]);
    expect(mockQueueAdd).toHaveBeenCalledOnce();
    expect(mockQueueAdd).toHaveBeenCalledWith("classify-tx", {
      userId: 42,
      mode: "specific",
      txIds: [101, 102, 103],
    });
  });

  it("swallows queue.add errors — does NOT rethrow", async () => {
    mockQueueAdd.mockRejectedValueOnce(new Error("Redis down"));
    // Should resolve without throwing.
    await expect(enqueueClassification(1, [1])).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #1040 — the call site is bounded, not the BullMQ client
//
// `maxRetriesPerRequest: null` (BullMQ requires it) means ioredis never
// rejects a queued command while Redis is down; the await simply never
// returns. The bound therefore belongs here: resolve as "deferred", log it as
// a deferral (never as a failure) and let the caller proceed — the tx is
// already persisted and the classify sweep picks it up later.
// ---------------------------------------------------------------------------

describe("enqueueClassification — bounded enqueue (#1040)", () => {
  beforeEach(() => {
    mockQueueAdd.mockReset();
  });

  it("S1: defaults the bound to 5 seconds", () => {
    expect(DEFAULT_ENQUEUE_TIMEOUT_MS).toBe(5_000);
  });

  it("S6: resolves when queue.add never settles (Redis down, no rejection)", async () => {
    mockQueueAdd.mockImplementationOnce(() => new Promise(() => {}));

    const startedAt = Date.now();
    await expect(enqueueClassification(7, [501, 502], { timeoutMs: 20 })).resolves.toBeUndefined();
    const elapsedMs = Date.now() - startedAt;

    // Bounded by the timeout, not by the (never-arriving) resolution.
    expect(elapsedMs).toBeGreaterThanOrEqual(15);
    expect(elapsedMs).toBeLessThan(1_000);
    // The attempt happened; we did not silently skip the enqueue.
    expect(mockQueueAdd).toHaveBeenCalledOnce();
  }, 3_000);

  it("S7: logs the deferral with user id, tx ids and elapsed time — not a failure", async () => {
    mockQueueAdd.mockImplementationOnce(() => new Promise(() => {}));

    await enqueueClassification(9, [601, 602], { timeoutMs: 20 });

    expect(mockLogWarn).toHaveBeenCalledOnce();
    const [fields, message] = mockLogWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({
      event: "classify_enqueue_deferred",
      outcome: "deferred",
      userId: 9,
      txIds: [601, 602],
      count: 2,
      timeoutMs: 20,
    });
    expect(typeof fields.elapsedMs).toBe("number");
    expect(fields.elapsedMs as number).toBeGreaterThanOrEqual(15);
    expect(message).toContain("deferred");

    // A persisted-but-unclassified tx is not an error; paging on it would lie.
    expect(mockLogError).not.toHaveBeenCalled();
    expect(mockLogInfo).not.toHaveBeenCalled();
  }, 3_000);

  it("S7: a rejected queue.add is still reported as a failure, not a deferral", async () => {
    mockQueueAdd.mockRejectedValueOnce(new Error("Redis down"));

    await enqueueClassification(9, [601]);

    expect(mockLogError).toHaveBeenCalledOnce();
    const [fields] = mockLogError.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({
      event: "classify_enqueue_failed",
      outcome: "failed",
      userId: 9,
      count: 1,
    });
    expect(mockLogWarn).not.toHaveBeenCalled();
    expect(mockLogInfo).not.toHaveBeenCalled();
  });

  it("S8: a normal enqueue is unchanged — resolves fast, logs enqueued, no deferral", async () => {
    mockQueueAdd.mockResolvedValueOnce({ id: "job-fast" });

    const startedAt = Date.now();
    // Long bound on purpose: a fast resolution must not wait for it.
    await enqueueClassification(11, [701], { timeoutMs: 5_000 });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1_000);
    expect(mockLogInfo).toHaveBeenCalledOnce();
    expect(mockLogInfo.mock.calls[0][0]).toMatchObject({
      event: "classify_enqueued",
      userId: 11,
      count: 1,
    });
    expect(mockLogWarn).not.toHaveBeenCalled();
    expect(mockLogError).not.toHaveBeenCalled();
  });
});

describe("enqueueAskUser", () => {
  beforeEach(() => {
    mockQueueAdd.mockReset();
  });

  it("calls queue.add with single-user payload", async () => {
    mockQueueAdd.mockResolvedValueOnce({ id: "job-ask-1" });
    await enqueueAskUser(42);
    expect(mockQueueAdd).toHaveBeenCalledOnce();
    expect(mockQueueAdd).toHaveBeenCalledWith("classify-ask", { mode: "single-user", userId: 42 });
  });

  it("swallows queue.add errors — does NOT rethrow", async () => {
    mockQueueAdd.mockRejectedValueOnce(new Error("Redis down"));
    await expect(enqueueAskUser(1)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// classifyByRuleThenEnqueue
// ---------------------------------------------------------------------------

describe("classifyByRuleThenEnqueue", () => {
  beforeEach(() => {
    mockQueueAdd.mockReset();
    mockQueueAdd.mockResolvedValue({ id: "job-1" });
    mockClassifyByRule.mockReset();
    mockSelectWhere.mockReset();
    mockUpdateWhere.mockReset();
    mockUpdateWhere.mockResolvedValue([]);
  });

  it("does nothing when txIds is empty", async () => {
    await classifyByRuleThenEnqueue(1, []);
    expect(mockClassifyByRule).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("enqueues only txIds that did not match a rule", async () => {
    // tx 10 matches a rule, tx 11 does not.
    mockSelectWhere.mockResolvedValueOnce([
      { id: 10, descriptionRaw: "RAPPI", merchant: "Rappi" },
      { id: 11, descriptionRaw: "RANDOM STORE", merchant: null },
    ]);

    mockClassifyByRule
      .mockResolvedValueOnce({ categorySlug: "comida", ruleId: 5, confidence: 100 }) // tx 10
      .mockResolvedValueOnce(null); // tx 11

    await classifyByRuleThenEnqueue(42, [10, 11]);

    // Rule engine ran for both.
    expect(mockClassifyByRule).toHaveBeenCalledTimes(2);
    // Only tx 11 (unclassified) goes to the queue.
    expect(mockQueueAdd).toHaveBeenCalledWith("classify-tx", {
      userId: 42,
      mode: "specific",
      txIds: [11],
    });
  });

  it("enqueues nothing when all txIds match a rule", async () => {
    mockSelectWhere.mockResolvedValueOnce([
      { id: 20, descriptionRaw: "SPOTIFY", merchant: "Spotify" },
    ]);

    mockClassifyByRule.mockResolvedValueOnce({
      categorySlug: "entretenimiento",
      ruleId: 3,
      confidence: 100,
    });

    await classifyByRuleThenEnqueue(1, [20]);

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("enqueues all txIds when no rule matches", async () => {
    mockSelectWhere.mockResolvedValueOnce([
      { id: 30, descriptionRaw: "UNKNOWN A", merchant: null },
      { id: 31, descriptionRaw: "UNKNOWN B", merchant: null },
    ]);

    mockClassifyByRule.mockResolvedValue(null);

    await classifyByRuleThenEnqueue(5, [30, 31]);

    expect(mockQueueAdd).toHaveBeenCalledWith("classify-tx", {
      userId: 5,
      mode: "specific",
      txIds: [30, 31],
    });
  });
});
