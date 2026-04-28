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
  eq: vi.fn((_col, val) => ({ eq: val })),
  inArray: vi.fn((_col, vals) => ({ inArray: vals })),
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { enqueueClassification, classifyByRuleThenEnqueue } from "./enqueue";

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
