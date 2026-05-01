// Tests for the tc-health-check BullMQ worker.
// The processor is tested directly — no Worker instantiation needed.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoist shared mock references so they work inside vi.mock factories.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  // db.select chain — two round-trips (multi + single currency)
  dbSelect: vi.fn(),

  // Multi-currency query chain: .from().leftJoin().where().groupBy()
  dbMultiFrom: vi.fn(),
  dbMultiLeftJoin: vi.fn(),
  dbMultiWhere: vi.fn(),
  dbMultiGroupBy: vi.fn(),

  // Single-currency query chain: .from().where()
  dbSingleFrom: vi.fn(),
  dbSingleWhere: vi.fn(),

  // emitNotification
  emitNotification: vi.fn(),

  // getCurrentFxRate
  getCurrentFxRate: vi.fn(),

  // logger
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => {
  // Multi-currency chain: .from().leftJoin().where().groupBy()
  const groupByFn = mocks.dbMultiGroupBy;
  const multiWhereFn = mocks.dbMultiWhere.mockReturnValue({ groupBy: groupByFn });
  const leftJoinFn = mocks.dbMultiLeftJoin.mockReturnValue({ where: multiWhereFn });
  const fromMultiFn = mocks.dbMultiFrom.mockReturnValue({ leftJoin: leftJoinFn });

  // Single-currency chain: .from().where()
  const whereFn = mocks.dbSingleWhere;
  const fromSingleFn = mocks.dbSingleFrom.mockReturnValue({ where: whereFn });

  // db.select alternates: 1st call = multi, 2nd call = single
  mocks.dbSelect.mockImplementation(() => {
    const callCount = mocks.dbSelect.mock.calls.length;
    if (callCount === 1) {
      return { from: fromMultiFn };
    }
    return { from: fromSingleFn };
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
    warn: mocks.logWarn,
  }),
}));

vi.mock("@/lib/notifications/emit", () => ({
  emitNotification: mocks.emitNotification,
}));

vi.mock("@/lib/fx/repo", () => ({
  getCurrentFxRate: mocks.getCurrentFxRate,
}));

vi.mock("@/lib/db/schema", () => ({
  accounts: {
    id: "id",
    userId: "user_id",
    name: "name",
    institution: "institution",
    currency: "currency",
    type: "type",
    metadata: "metadata",
    physicalCardId: "physical_card_id",
    deletedAt: "deleted_at",
  },
  physicalCards: {
    id: "id",
    userId: "user_id",
    name: "name",
    institution: "institution",
    network: "network",
    last4: "last4",
    creditLimitCents: "credit_limit_cents",
    statementCutoffDay: "statement_cutoff_day",
  },
}));

vi.mock("@/lib/db/helpers", () => ({
  notDeleted: vi.fn(() => "notDeleted()"),
}));

vi.mock("@/lib/accounts/queries", () => ({
  derivedBalanceCentsSql: "derived_balance_cents_sql",
}));

vi.mock("@/lib/accounts/format", () => ({
  formatAccountLabel: vi.fn((a: { name: string; currency: string }) => `${a.name} (${a.currency})`),
}));

vi.mock("@/lib/money", () => ({
  toCop: vi.fn((cents: bigint, _currency: string, _rate: number) => cents),
}));

vi.mock("@/lib/widgets/handlers/_shared", () => ({
  nowInBogota: vi.fn(() => ({ year: 2026, month: 5, day: 1 })),
  roundUtilizationPct: vi.fn((used: bigint, limit: bigint) => {
    if (limit === BigInt(0)) return 0;
    return Math.round((Number(used) / Number(limit)) * 100);
  }),
}));

vi.mock("@/lib/widgets/handlers/tc-focus", () => ({
  computeNextCutoff: vi.fn(
    (_cutoffDay: number, today: { day: number; month: number; year: number }) => {
      // Simple mock: cutoff is cutoffDay - today.day days away
      const daysTo = _cutoffDay - today.day;
      return { next: `2026-05-${String(_cutoffDay).padStart(2, "0")}`, daysTo };
    },
  ),
}));

// aliasedTable stub
vi.mock("drizzle-orm", async (importOriginal) => {
  const original = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...original,
    sql: vi.fn(() => "sql()"),
    isNull: vi.fn(() => "isNull()"),
    eq: vi.fn(() => "eq()"),
    and: vi.fn(() => "and()"),
  };
});

import type { Job } from "bullmq";
import {
  tcHealthCheckProcessor,
  getCurrentYearMonth,
  type TcHealthCheckJobData,
} from "./tc-health-check";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(data: TcHealthCheckJobData = {}): Job<TcHealthCheckJobData> {
  return {
    id: "test-job-tc-health",
    data,
    updateProgress: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job<TcHealthCheckJobData>;
}

/** Reset and re-wire mock chains after vi.resetAllMocks. */
function rewireDbMock() {
  const groupByFn = mocks.dbMultiGroupBy;
  const multiWhereFn = mocks.dbMultiWhere.mockReturnValue({ groupBy: groupByFn });
  const leftJoinFn = mocks.dbMultiLeftJoin.mockReturnValue({ where: multiWhereFn });
  const fromMultiFn = mocks.dbMultiFrom.mockReturnValue({ leftJoin: leftJoinFn });

  const whereFn = mocks.dbSingleWhere;
  const fromSingleFn = mocks.dbSingleFrom.mockReturnValue({ where: whereFn });

  mocks.dbSelect.mockImplementation(() => {
    const callCount = mocks.dbSelect.mock.calls.length;
    if (callCount === 1) {
      return { from: fromMultiFn };
    }
    return { from: fromSingleFn };
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
// tcHealthCheckProcessor
// ---------------------------------------------------------------------------

describe("tcHealthCheckProcessor", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    rewireDbMock();
    // Default FX rate — not used unless USD involved
    mocks.getCurrentFxRate.mockResolvedValue({ rate: 4000, source: "db", fetchedAt: new Date() });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: No cards — completes cleanly without emit
  // -------------------------------------------------------------------------
  it("completes without error or emit when no cards exist", async () => {
    mocks.dbMultiGroupBy.mockResolvedValueOnce([]);
    mocks.dbSingleWhere.mockResolvedValueOnce([]);

    await expect(tcHealthCheckProcessor(makeJob())).resolves.toBeUndefined();
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 2: Multi-currency card with high utilization → emit util-95
  // -------------------------------------------------------------------------
  it("emits util-95 notification for a multi-currency card at 95% utilization", async () => {
    // creditLimit = 10_000_000, cop debt = 9_500_000 → used=9_500_000 → 95%
    const limit = BigInt(10_000_000);
    const debt = BigInt(-9_500_000); // balances are negative = debt
    mocks.dbMultiGroupBy.mockResolvedValueOnce([
      {
        id: "uuid-card-1",
        name: "Visa Premium",
        institution: "Bancolombia",
        network: "visa",
        last4: "1234",
        creditLimitCents: limit,
        statementCutoffDay: null, // no cutoff
        userId: 1,
        copDebtCents: debt.toString(),
        usdDebtCents: "0",
      },
    ]);
    mocks.dbSingleWhere.mockResolvedValueOnce([]);
    mocks.emitNotification.mockResolvedValue({ id: 10 });

    await tcHealthCheckProcessor(makeJob());

    expect(mocks.emitNotification).toHaveBeenCalledOnce();
    const [userId, input] = mocks.emitNotification.mock.calls[0] as [
      number,
      Parameters<typeof mocks.emitNotification>[1],
    ];
    expect(userId).toBe(1);
    expect(input.type).toBe("tc_health_alert");
    expect(input.entityId).toMatch(/^tc-alert-pc-uuid-card-1-\d{4}-\d{2}-util-/);
    expect(input.priority).toBe("medium");
    expect(input.actionUrl).toBe("/insights");
  });

  // -------------------------------------------------------------------------
  // Test 3: Single-currency card with statement approaching → emit statement
  // -------------------------------------------------------------------------
  it("emits statement notification for a single-currency card with cutoff in 2 days", async () => {
    mocks.dbMultiGroupBy.mockResolvedValueOnce([]);
    mocks.dbSingleWhere.mockResolvedValueOnce([
      {
        id: 42,
        name: "MasterCard",
        institution: "Davivienda",
        currency: "COP",
        metadata: {
          creditLimitCents: 5_000_000,
          cutoffDay: 3, // mocked today.day = 1 → daysTo = 2
        },
        userId: 2,
        balanceCents: "0", // no debt
      },
    ]);
    mocks.emitNotification.mockResolvedValue({ id: 20 });

    await tcHealthCheckProcessor(makeJob());

    expect(mocks.emitNotification).toHaveBeenCalledOnce();
    const [userId, input] = mocks.emitNotification.mock.calls[0] as [
      number,
      Parameters<typeof mocks.emitNotification>[1],
    ];
    expect(userId).toBe(2);
    expect(input.type).toBe("tc_health_alert");
    expect(input.entityId).toMatch(/statement$/);
  });

  // -------------------------------------------------------------------------
  // Test 4: Dedup — emitNotification returns null, no error
  // -------------------------------------------------------------------------
  it("handles dedup gracefully when emitNotification returns null", async () => {
    mocks.dbMultiGroupBy.mockResolvedValueOnce([]);
    mocks.dbSingleWhere.mockResolvedValueOnce([
      {
        id: 7,
        name: "Card",
        institution: "Nequi",
        currency: "COP",
        metadata: { creditLimitCents: 2_000_000, cutoffDay: 2 }, // daysTo = 1
        userId: 3,
        balanceCents: "0",
      },
    ]);
    mocks.emitNotification.mockResolvedValue(null); // deduped

    await expect(tcHealthCheckProcessor(makeJob())).resolves.toBeUndefined();
    expect(mocks.emitNotification).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 5: Per-card emit failure is contained — other cards still process
  // -------------------------------------------------------------------------
  it("logs error and continues when one emit fails — other cards still fire", async () => {
    mocks.dbMultiGroupBy.mockResolvedValueOnce([]);
    mocks.dbSingleWhere.mockResolvedValueOnce([
      {
        id: 1,
        name: "Card A",
        institution: "Banco A",
        currency: "COP",
        metadata: { creditLimitCents: 1_000_000, cutoffDay: 2 }, // daysTo = 1 → statement
        userId: 1,
        balanceCents: "0",
      },
      {
        id: 2,
        name: "Card B",
        institution: "Banco B",
        currency: "COP",
        metadata: { creditLimitCents: 1_000_000, cutoffDay: 3 }, // daysTo = 2 → statement
        userId: 2,
        balanceCents: "0",
      },
    ]);

    mocks.emitNotification
      .mockRejectedValueOnce(new Error("db timeout"))
      .mockResolvedValueOnce({ id: 99 });

    // Must NOT throw
    await expect(tcHealthCheckProcessor(makeJob())).resolves.toBeUndefined();
    expect(mocks.emitNotification).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Test 6: Skip cards with no cutoff AND zero limit
  // -------------------------------------------------------------------------
  it("skips multi-currency cards with null cutoffDay AND zero creditLimit", async () => {
    mocks.dbMultiGroupBy.mockResolvedValueOnce([
      {
        id: "uuid-skip",
        name: null,
        institution: "Banco",
        network: null,
        last4: null,
        creditLimitCents: BigInt(0), // no cupo
        statementCutoffDay: null,
        userId: 1,
        copDebtCents: "0",
        usdDebtCents: "0",
      },
    ]);
    mocks.dbSingleWhere.mockResolvedValueOnce([]);

    await tcHealthCheckProcessor(makeJob());
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 7: DB failure propagates for BullMQ retry
  // -------------------------------------------------------------------------
  it("propagates DB errors for BullMQ retry", async () => {
    mocks.dbMultiGroupBy.mockRejectedValueOnce(new Error("connection refused"));

    await expect(tcHealthCheckProcessor(makeJob())).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Test 8: updateProgress called at start and done
  // -------------------------------------------------------------------------
  it("calls updateProgress at start and done", async () => {
    mocks.dbMultiGroupBy.mockResolvedValueOnce([]);
    mocks.dbSingleWhere.mockResolvedValueOnce([]);

    const job = makeJob();
    await tcHealthCheckProcessor(job);

    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: "fetching" }));
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ done: true }));
    expect(job.log).toHaveBeenCalled();
  });
});
