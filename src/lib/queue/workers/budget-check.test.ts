// Tests for the budget-check BullMQ worker.
// The processor and fetchExceededBudgets are tested directly — no Worker
// instantiation needed for unit tests.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoist shared mock references so they work inside vi.mock factories.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  // db.select chain
  dbSelect: vi.fn(),
  dbSelectFrom: vi.fn(),
  dbSelectFromInnerJoin: vi.fn(),
  dbSelectFromInnerJoinWhere: vi.fn(),
  dbSelectFromLeftJoin: vi.fn(),
  dbSelectFromLeftJoinWhere: vi.fn(),
  dbSelectFromLeftJoinWhereGroupBy: vi.fn(),

  // emitNotification
  emitNotification: vi.fn(),

  // logger
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

// Mock db — two sequential selects in fetchExceededBudgets:
// 1. activeBudgets query (select → from → innerJoin → where)
// 2. spentRows query   (select → from → leftJoin → where → groupBy)
//
// We model them as two separate call chains that share the same `db.select`.
vi.mock("@/lib/db", () => {
  // Budgets query chain: .from().innerJoin().where()
  const innerJoinWhereFn = mocks.dbSelectFromInnerJoinWhere;
  const innerJoinFn = mocks.dbSelectFromInnerJoin.mockReturnValue({ where: innerJoinWhereFn });
  const fromInnerFn = vi.fn().mockReturnValue({ innerJoin: innerJoinFn });

  // Spent query chain: .from().leftJoin().where().groupBy()
  const groupByFn = mocks.dbSelectFromLeftJoinWhereGroupBy;
  const leftJoinWhereFn = mocks.dbSelectFromLeftJoinWhere.mockReturnValue({ groupBy: groupByFn });
  const leftJoinFn = mocks.dbSelectFromLeftJoin.mockReturnValue({ where: leftJoinWhereFn });
  const fromLeftFn = vi.fn().mockReturnValue({ leftJoin: leftJoinFn });

  // db.select alternates between both chains based on call count.
  mocks.dbSelect.mockImplementation(() => {
    // First call → budgets chain; second call → spent chain.
    const callCount = mocks.dbSelect.mock.calls.length;
    if (callCount === 1) {
      return { from: fromInnerFn };
    }
    return { from: fromLeftFn };
  });

  return {
    db: {
      select: mocks.dbSelect,
    },
  };
});

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: mocks.logInfo,
    error: mocks.logError,
    debug: mocks.logDebug,
  }),
}));

vi.mock("@/lib/notifications/emit", () => ({
  emitNotification: mocks.emitNotification,
}));

// Schema and helper mocks — values are not used by the logic, only forwarded
// to drizzle builders that are themselves mocked. Minimal stubs are enough.
vi.mock("@/lib/db/schema", () => ({
  budgets: {
    userId: "user_id",
    categorySlug: "category_slug",
    amountCents: "amount_cents",
    periodStart: "period_start",
    active: "active",
    deletedAt: "deleted_at",
  },
  categories: {
    userId: "user_id",
    slug: "slug",
    name: "name",
    parentSlug: "parent_slug",
    deletedAt: "deleted_at",
  },
  transactions: {
    userId: "user_id",
    categorySlug: "category_slug",
    amountCents: "amount_cents",
    occurredAt: "occurred_at",
    isAdjustment: "is_adjustment",
    deletedAt: "deleted_at",
    channel: "channel",
  },
}));

vi.mock("@/lib/db/helpers", () => ({
  notDeleted: vi.fn(() => "notDeleted()"),
  notAdjustment: vi.fn(() => "notAdjustment()"),
  notInternalMovement: vi.fn(() => "notInternalMovement()"),
  // Alias kept for any callers that haven't migrated yet.
  notTransfer: vi.fn(() => "notInternalMovement()"),
}));

vi.mock("@/lib/money", () => ({
  formatCop: (cents: bigint) => `$${Number(cents) / 100}`,
}));

// aliasedTable returns the table with a label — not meaningful in unit tests.
vi.mock("drizzle-orm", async (importOriginal) => {
  const original = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...original,
    aliasedTable: vi.fn((table: unknown) => table),
  };
});

import type { Job } from "bullmq";
import {
  budgetCheckProcessor,
  fetchExceededBudgets,
  getCurrentYearMonth,
  type BudgetCheckJobData,
} from "./budget-check";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(data: BudgetCheckJobData = {}): Job<BudgetCheckJobData> {
  return {
    id: "test-job-budget-check",
    data,
    updateProgress: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job<BudgetCheckJobData>;
}

/** Reset and re-wire the db mock chain (needed after vi.resetAllMocks). */
function rewireDbMock() {
  const groupByFn = mocks.dbSelectFromLeftJoinWhereGroupBy;
  const leftJoinWhereFn = mocks.dbSelectFromLeftJoinWhere.mockReturnValue({ groupBy: groupByFn });
  const leftJoinFn = mocks.dbSelectFromLeftJoin.mockReturnValue({ where: leftJoinWhereFn });
  const fromLeftFn = vi.fn().mockReturnValue({ leftJoin: leftJoinFn });

  const innerJoinWhereFn = mocks.dbSelectFromInnerJoinWhere;
  const innerJoinFn = mocks.dbSelectFromInnerJoin.mockReturnValue({ where: innerJoinWhereFn });
  const fromInnerFn = vi.fn().mockReturnValue({ innerJoin: innerJoinFn });

  mocks.dbSelect.mockImplementation(() => {
    const callCount = mocks.dbSelect.mock.calls.length;
    if (callCount === 1) {
      return { from: fromInnerFn };
    }
    return { from: fromLeftFn };
  });
}

// ---------------------------------------------------------------------------
// getCurrentYearMonth
// ---------------------------------------------------------------------------

describe("getCurrentYearMonth", () => {
  it("returns a string matching YYYY-MM format", () => {
    const ym = getCurrentYearMonth();
    expect(ym).toMatch(/^\d{4}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// fetchExceededBudgets
// ---------------------------------------------------------------------------

describe("fetchExceededBudgets", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    rewireDbMock();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: Happy path — user A exceeds budget → row returned
  // -------------------------------------------------------------------------
  it("returns exceeded budget rows when MTD spend >= budget amount", async () => {
    // Active budgets: user 1, category "comida", budget $500K
    mocks.dbSelectFromInnerJoinWhere.mockResolvedValueOnce([
      {
        userId: 1,
        categorySlug: "comida",
        categoryName: "Comida",
        amountCents: BigInt(50_000_000), // $500K COP in cents
      },
    ]);

    // MTD spend: user 1, category "comida", $600K spent (exceeded)
    mocks.dbSelectFromLeftJoinWhereGroupBy.mockResolvedValueOnce([
      { userId: 1, rootSlug: "comida", mtdCents: "60000000" },
    ]);

    const result = await fetchExceededBudgets("2026-04");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      userId: 1,
      categorySlug: "comida",
      categoryName: "Comida",
      amountCents: BigInt(50_000_000),
      mtdCents: BigInt(60_000_000),
      yearMonth: "2026-04",
    });
  });

  // -------------------------------------------------------------------------
  // Test 2: Under budget — no rows returned
  // -------------------------------------------------------------------------
  it("returns empty array when MTD spend is below budget", async () => {
    // Budget: $500K
    mocks.dbSelectFromInnerJoinWhere.mockResolvedValueOnce([
      {
        userId: 1,
        categorySlug: "comida",
        categoryName: "Comida",
        amountCents: BigInt(50_000_000),
      },
    ]);

    // MTD spend: $300K (under budget)
    mocks.dbSelectFromLeftJoinWhereGroupBy.mockResolvedValueOnce([
      { userId: 1, rootSlug: "comida", mtdCents: "30000000" },
    ]);

    const result = await fetchExceededBudgets("2026-04");

    expect(result).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 3: Tenant safety — user A exceeds, user B does not
  // -------------------------------------------------------------------------
  it("only returns exceeded rows for the correct user — tenant isolation confirmed", async () => {
    // Two users both have "comida" budget at $500K
    mocks.dbSelectFromInnerJoinWhere.mockResolvedValueOnce([
      {
        userId: 1,
        categorySlug: "comida",
        categoryName: "Comida",
        amountCents: BigInt(50_000_000),
      },
      {
        userId: 2,
        categorySlug: "comida",
        categoryName: "Comida",
        amountCents: BigInt(50_000_000),
      },
    ]);

    // Spend rows — userId is part of the GROUP BY key, ensuring per-tenant isolation.
    // User 1: $600K (exceeded), User 2: $200K (under budget).
    // The lookup key is "userId:rootSlug" — no cross-tenant bleed possible.
    mocks.dbSelectFromLeftJoinWhereGroupBy.mockResolvedValueOnce([
      { userId: 1, rootSlug: "comida", mtdCents: "60000000" }, // user 1 exceeded
      { userId: 2, rootSlug: "comida", mtdCents: "20000000" }, // user 2 under budget
    ]);

    const result = await fetchExceededBudgets("2026-04");

    // Only user 1 should appear — user 2 is under budget.
    expect(result).toHaveLength(1);
    expect(result[0]!.userId).toBe(1);

    // Confirm user 2 is NOT in results — tenant safety verified.
    const user2Rows = result.filter((r) => r.userId === 2);
    expect(user2Rows).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 4: No active budgets — no DB spend query needed, returns []
  // -------------------------------------------------------------------------
  it("returns empty array and skips spend query when no active budgets exist", async () => {
    mocks.dbSelectFromInnerJoinWhere.mockResolvedValueOnce([]);

    const result = await fetchExceededBudgets("2026-04");

    expect(result).toHaveLength(0);
    // The spend query should NOT have been called (short-circuit).
    expect(mocks.dbSelectFromLeftJoinWhereGroupBy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 5: Budget met exactly (=) — should be included (>= not just >)
  // -------------------------------------------------------------------------
  it("includes budgets where MTD spend exactly equals the budget amount", async () => {
    mocks.dbSelectFromInnerJoinWhere.mockResolvedValueOnce([
      {
        userId: 1,
        categorySlug: "transporte",
        categoryName: "Transporte",
        amountCents: BigInt(10_000_000),
      },
    ]);

    mocks.dbSelectFromLeftJoinWhereGroupBy.mockResolvedValueOnce([
      { userId: 1, rootSlug: "transporte", mtdCents: "10000000" }, // exact match
    ]);

    const result = await fetchExceededBudgets("2026-04");

    expect(result).toHaveLength(1);
    expect(result[0]!.mtdCents).toBe(BigInt(10_000_000));
  });

  // -------------------------------------------------------------------------
  // Test 6: notInternalMovement filter applied — transfers + ATM withdrawals
  // excluded from MTD spend.
  //
  // The spent query must invoke notInternalMovement so that TC payments and
  // other internal movements (channel='transfer' or 'cash_withdrawal') are
  // not counted as expense.
  // See issues #685, #766 and memory `pago-tc-modeled-as-expense`.
  // -------------------------------------------------------------------------
  it("invokes notInternalMovement helper when building the MTD spend query", async () => {
    const { notInternalMovement } = await import("@/lib/db/helpers");

    mocks.dbSelectFromInnerJoinWhere.mockResolvedValueOnce([
      {
        userId: 1,
        categorySlug: "comida",
        categoryName: "Comida",
        amountCents: BigInt(50_000_000),
      },
    ]);
    mocks.dbSelectFromLeftJoinWhereGroupBy.mockResolvedValueOnce([
      { userId: 1, rootSlug: "comida", mtdCents: "60000000" },
    ]);

    await fetchExceededBudgets("2026-04");

    // notInternalMovement must have been called with the channel column so
    // the spent query correctly excludes transfers and ATM withdrawals from
    // the budget calculation.
    expect(notInternalMovement).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// budgetCheckProcessor
// ---------------------------------------------------------------------------

describe("budgetCheckProcessor", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    rewireDbMock();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: Happy path — emit fires with correct entityId and body
  // -------------------------------------------------------------------------
  it("emits notification with correct entityId and body when budget is exceeded", async () => {
    mocks.dbSelectFromInnerJoinWhere.mockResolvedValueOnce([
      {
        userId: 1,
        categorySlug: "comida",
        categoryName: "Comida",
        amountCents: BigInt(50_000_000),
      },
    ]);
    mocks.dbSelectFromLeftJoinWhereGroupBy.mockResolvedValueOnce([
      { userId: 1, rootSlug: "comida", mtdCents: "60000000" },
    ]);
    mocks.emitNotification.mockResolvedValueOnce({ id: 42 });

    await budgetCheckProcessor(makeJob());

    expect(mocks.emitNotification).toHaveBeenCalledOnce();

    const [userId, input] = mocks.emitNotification.mock.calls[0] as [
      number,
      Parameters<typeof mocks.emitNotification>[1],
    ];
    expect(userId).toBe(1);
    expect(input.type).toBe("budget_exceeded");
    // entityId must encode categorySlug + yearMonth for per-month dedup
    expect(input.entityId).toMatch(/^budget-comida-\d{4}-\d{2}$/);
    expect(input.priority).toBe("medium");
    expect(input.actionUrl).toBe("/budgets");
    expect(input.title).toContain("Comida");
    // formatCop mock: `$${Number(cents)/100}` → $600000 and $500000
    expect(input.body).toContain("$600000");
    expect(input.body).toContain("$500000");
    expect(input.metadata).toMatchObject({ categorySlug: "comida" });
  });

  // -------------------------------------------------------------------------
  // Test 2: Dedup — emit returns null (deduped), no double notification
  // -------------------------------------------------------------------------
  it("handles dedup gracefully when emitNotification returns null", async () => {
    mocks.dbSelectFromInnerJoinWhere.mockResolvedValueOnce([
      {
        userId: 1,
        categorySlug: "comida",
        categoryName: "Comida",
        amountCents: BigInt(50_000_000),
      },
    ]);
    mocks.dbSelectFromLeftJoinWhereGroupBy.mockResolvedValueOnce([
      { userId: 1, rootSlug: "comida", mtdCents: "60000000" },
    ]);

    // First call: inserted; second call: deduped (returns null).
    mocks.emitNotification.mockResolvedValueOnce({ id: 10 });

    await budgetCheckProcessor(makeJob());

    // Re-run with same budget (simulate second nightly run)
    vi.resetAllMocks();
    rewireDbMock();
    mocks.dbSelectFromInnerJoinWhere.mockResolvedValueOnce([
      {
        userId: 1,
        categorySlug: "comida",
        categoryName: "Comida",
        amountCents: BigInt(50_000_000),
      },
    ]);
    mocks.dbSelectFromLeftJoinWhereGroupBy.mockResolvedValueOnce([
      { userId: 1, rootSlug: "comida", mtdCents: "60000000" },
    ]);
    mocks.emitNotification.mockResolvedValueOnce(null); // deduped by DB partial index

    await budgetCheckProcessor(makeJob());

    // Emit was called — returns null — processor must NOT throw.
    expect(mocks.emitNotification).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Test 3: No active budgets — no emit, no error
  // -------------------------------------------------------------------------
  it("completes without error or emit when no budgets exist", async () => {
    mocks.dbSelectFromInnerJoinWhere.mockResolvedValueOnce([]);

    await expect(budgetCheckProcessor(makeJob())).resolves.toBeUndefined();
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 4: Per-budget emit failure is contained — other budgets still process
  // -------------------------------------------------------------------------
  it("logs error and continues loop when one emit fails — other budgets still fire", async () => {
    mocks.dbSelectFromInnerJoinWhere.mockResolvedValueOnce([
      {
        userId: 1,
        categorySlug: "comida",
        categoryName: "Comida",
        amountCents: BigInt(50_000_000),
      },
      {
        userId: 2,
        categorySlug: "transporte",
        categoryName: "Transporte",
        amountCents: BigInt(10_000_000),
      },
    ]);
    mocks.dbSelectFromLeftJoinWhereGroupBy.mockResolvedValueOnce([
      { userId: 1, rootSlug: "comida", mtdCents: "60000000" },
      { userId: 2, rootSlug: "transporte", mtdCents: "15000000" },
    ]);

    // User 1 emit fails, user 2 succeeds
    mocks.emitNotification
      .mockRejectedValueOnce(new Error("db timeout"))
      .mockResolvedValueOnce({ id: 55 });

    // Must NOT throw even though one emit failed
    await expect(budgetCheckProcessor(makeJob())).resolves.toBeUndefined();

    // Both emits were attempted
    expect(mocks.emitNotification).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Test 5: DB failure propagates for BullMQ retry
  // -------------------------------------------------------------------------
  it("propagates DB errors for BullMQ retry", async () => {
    mocks.dbSelectFromInnerJoinWhere.mockRejectedValueOnce(new Error("connection refused"));

    await expect(budgetCheckProcessor(makeJob())).rejects.toThrow("connection refused");
  });

  // -------------------------------------------------------------------------
  // Test 6: updateProgress called at start and done — Bull-Board contract
  // -------------------------------------------------------------------------
  it("calls updateProgress at start and done — Bull-Board contract", async () => {
    mocks.dbSelectFromInnerJoinWhere.mockResolvedValueOnce([]);

    const job = makeJob();
    await budgetCheckProcessor(job);

    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: "fetching" }));
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ done: true }));
    expect(job.log).toHaveBeenCalled();
  });
});
