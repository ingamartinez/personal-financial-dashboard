/**
 * Unit tests for the enqueueClassification wiring in ingestArqEmail (#645).
 *
 * All external dependencies (DB, queue, parser, helpers) are mocked so these
 * tests run without a live Postgres / Redis connection and are O(ms) fast.
 * The default Vitest env (node) is intentional — no DOM needed.
 */

// ---------------------------------------------------------------------------
// Mock hoisting — vi.hoisted() must be called before vi.mock() factories
// reference shared state.
// ---------------------------------------------------------------------------
const {
  mockQueueAdd,
  mockInsertReturning,
  mockUpdateSet,
  mockSelectFrom,
  mockParseArqEmail,
  mockAutoLink,
  mockPair,
  mockResolveCounterparty,
  mockEmit,
} = vi.hoisted(() => ({
  mockQueueAdd: vi.fn(),
  mockInsertReturning: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockSelectFrom: vi.fn(),
  mockParseArqEmail: vi.fn(),
  mockAutoLink: vi.fn(),
  mockPair: vi.fn(),
  mockResolveCounterparty: vi.fn(),
  mockEmit: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/queue", () => ({
  createQueue: vi.fn(() => ({ add: mockQueueAdd })),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: mockSelectFrom,
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: mockInsertReturning,
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: mockUpdateSet,
      })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  accounts: { id: "id", userId: "userId", deletedAt: "deletedAt" },
  emailReceipts: { id: "id", userId: "userId" },
  transactions: {
    id: "id",
    userId: "userId",
    accountId: "accountId",
    externalId: "externalId",
  },
}));

vi.mock("@/lib/db/helpers", () => ({
  notDeleted: vi.fn(() => ({ notDeleted: true })),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...preds) => ({ and: preds })),
  eq: vi.fn((_col, val) => ({ eq: val })),
  sql: new Proxy(
    (strings: TemplateStringsArray, ...values: unknown[]) =>
      ({ sql: strings.join("?"), values }),
    { get: (_t, p) => (p === Symbol.toPrimitive ? String : undefined) },
  ),
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("@/lib/events/bus", () => ({
  emit: mockEmit,
}));

vi.mock("@/lib/recurring/auto-link", () => ({
  autoLinkTransaction: mockAutoLink,
}));

vi.mock("@/lib/transfers/intra-user-pair", () => ({
  pairIntraUserTransfer: mockPair,
}));

vi.mock("@/lib/gmail/parsers/arq", () => ({
  parseArqEmail: mockParseArqEmail,
}));

vi.mock("@/lib/ingestion/sms-pipeline", () => ({
  resolveCounterpartyByKey: mockResolveCounterparty,
}));

vi.mock("@/lib/counterparties/alias-key", () => ({
  normalizeName: vi.fn((name: string) => name.toUpperCase()),
}));

// ---------------------------------------------------------------------------
// Subject under test — imported AFTER all vi.mock() calls
// ---------------------------------------------------------------------------
import { ingestArqEmail } from "./email-arq";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HAPPY_PARSED = {
  kind: "parsed" as const,
  txKind: "transfer_sent" as const,
  counterpartyName: "GUSTAVO PEREZ",
  amountUsdcCents: BigInt(10000),
  copAmountCents: BigInt(40000000),
  impliedTrmCopPerUsdc: 4000,
  occurredAt: new Date("2026-04-01T10:00:00Z"),
};

const ARQ_ACCOUNT = {
  id: 99,
  currency: "USD",
  institutionSlug: "other",
  metadata: { last4s: ["7073"] },
};

// ---------------------------------------------------------------------------
// Helper: configure all mocks for the happy path
// ---------------------------------------------------------------------------
function setupHappyPath(txId: number) {
  mockParseArqEmail.mockReturnValue(HAPPY_PARSED);
  // DB SELECT returns the ARQ account for this user.
  mockSelectFrom.mockResolvedValue([ARQ_ACCOUNT]);
  // DB INSERT returns the new tx row.
  mockInsertReturning.mockResolvedValue([{ id: txId }]);
  // UPDATE (markReceiptMatched) is a fire-and-forget side effect.
  mockUpdateSet.mockResolvedValue([]);
  // Helpers are no-ops for this test.
  mockAutoLink.mockResolvedValue(undefined);
  mockPair.mockResolvedValue(undefined);
  mockResolveCounterparty.mockResolvedValue({ counterpartyId: 7 });
  mockQueueAdd.mockResolvedValue({ id: "job-123" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ingestArqEmail — enqueue classification after insert (#645)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls enqueueClassification with the inserted txId on a happy-path insert", async () => {
    setupHappyPath(42);

    const result = await ingestArqEmail(1, 10, "<html/>", new Date());

    expect(result.status).toBe("inserted");
    if (result.status === "inserted") {
      expect(result.txId).toBe(42);
    }

    // queue.add must be called exactly once with the correct classify-tx payload.
    expect(mockQueueAdd).toHaveBeenCalledOnce();
    expect(mockQueueAdd).toHaveBeenCalledWith("classify-tx", {
      userId: 1,
      mode: "specific",
      txIds: [42],
    });
  });

  it("does NOT call enqueueClassification on a duplicate insert (result.length === 0)", async () => {
    mockParseArqEmail.mockReturnValue(HAPPY_PARSED);
    mockSelectFrom.mockResolvedValue([ARQ_ACCOUNT]);
    // Conflict → empty array returned by .returning().
    mockInsertReturning.mockResolvedValue([]);
    mockResolveCounterparty.mockResolvedValue({ counterpartyId: 7 });

    const result = await ingestArqEmail(1, 10, "<html/>", new Date());

    expect(result.status).toBe("duplicated");
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("does NOT call enqueueClassification when the parser skips the email", async () => {
    mockParseArqEmail.mockReturnValue({ kind: "skip", reason: "non_transactional" });
    mockUpdateSet.mockResolvedValue([]);

    const result = await ingestArqEmail(1, 10, "<html/>", new Date());

    expect(result.status).toBe("skipped");
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("does NOT call enqueueClassification when the parser returns needs_review", async () => {
    mockParseArqEmail.mockReturnValue({
      kind: "needs_review",
      reason: "unknown_arq_template",
    });
    mockUpdateSet.mockResolvedValue([]);

    const result = await ingestArqEmail(1, 10, "<html/>", new Date());

    expect(result.status).toBe("error");
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("still returns inserted and logs gracefully when queue.add fails (Redis down)", async () => {
    setupHappyPath(55);
    // Simulate Redis being down — queue.add rejects.
    mockQueueAdd.mockRejectedValueOnce(new Error("Redis down"));

    // enqueueClassification swallows the error — ingestArqEmail must still succeed.
    const result = await ingestArqEmail(1, 10, "<html/>", new Date());

    expect(result.status).toBe("inserted");
    // queue.add was called (not silently skipped).
    expect(mockQueueAdd).toHaveBeenCalledOnce();
  });
});
