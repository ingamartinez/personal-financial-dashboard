// Tests for tc-health-queries.ts — snapshot builders and fetchUserTcSnapshots.
// The DB round-trips are mocked; only the pure logic is tested here.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoist shared mock references
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
      const daysTo = _cutoffDay - today.day;
      return { next: `2026-05-${String(_cutoffDay).padStart(2, "0")}`, daysTo };
    },
  ),
}));

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

import {
  buildMultiSnapshot,
  buildSingleSnapshot,
  fetchUserTcSnapshots,
  type MultiCurrencyRow,
  type SingleCurrencyRow,
} from "./tc-health-queries";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const TODAY = { year: 2026, month: 5, day: 1 };

// ---------------------------------------------------------------------------
// buildMultiSnapshot
// ---------------------------------------------------------------------------

describe("buildMultiSnapshot", () => {
  it("computes utilizationPct and usedCents from COP debt", () => {
    const row: MultiCurrencyRow = {
      id: "uuid-1",
      name: "Visa",
      institution: "Bancolombia",
      network: "visa",
      last4: "1234",
      creditLimitCents: BigInt(10_000_000),
      statementCutoffDay: null,
      userId: 1,
      copDebtCents: BigInt(-9_500_000), // negative = owed
      usdDebtCents: BigInt(0),
    };
    // toCop mock returns cents as-is; usdDebtInCop = 0
    // available = 10_000_000 + (-9_500_000) + 0 = 500_000
    // used = 10_000_000 - 500_000 = 9_500_000 → 95%
    const snap = buildMultiSnapshot(row, 4000, TODAY);
    expect(snap.cardId).toBe("pc-uuid-1");
    expect(snap.kind).toBe("physical");
    expect(snap.currency).toBe("COP");
    expect(snap.usedCents).toBe(BigInt(9_500_000));
    expect(snap.utilizationPct).toBe(95);
  });

  it("clamps usedCents to 0 when debt is positive (credit balance)", () => {
    const row: MultiCurrencyRow = {
      id: "uuid-2",
      name: null,
      institution: "Banco",
      network: null,
      last4: null,
      creditLimitCents: BigInt(5_000_000),
      statementCutoffDay: null,
      userId: 1,
      copDebtCents: BigInt(100_000), // positive = credit balance (overpaid)
      usdDebtCents: BigInt(0),
    };
    // available = 5_000_000 + 100_000 = 5_100_000 → usedCents = 5_000_000 - 5_100_000 = -100_000 → clamped to 0
    const snap = buildMultiSnapshot(row, 4000, TODAY);
    expect(snap.usedCents).toBe(BigInt(0));
    expect(snap.utilizationPct).toBe(0);
  });

  it("sets daysToCutoff from statementCutoffDay — mock returns cutoffDay - today.day", () => {
    const row: MultiCurrencyRow = {
      id: "uuid-3",
      name: "Card",
      institution: "Banco",
      network: null,
      last4: null,
      creditLimitCents: BigInt(1_000_000),
      statementCutoffDay: 4, // today.day=1 → daysTo=3
      userId: 1,
      copDebtCents: BigInt(0),
      usdDebtCents: BigInt(0),
    };
    const snap = buildMultiSnapshot(row, 4000, TODAY);
    expect(snap.daysToCutoff).toBe(3);
    expect(snap.cutoffDay).toBe(4);
  });

  it("uses institution + last4 as label when name is null", () => {
    const row: MultiCurrencyRow = {
      id: "uuid-4",
      name: null,
      institution: "Davivienda",
      network: null,
      last4: "5678",
      creditLimitCents: BigInt(1_000_000),
      statementCutoffDay: null,
      userId: 1,
      copDebtCents: BigInt(0),
      usdDebtCents: BigInt(0),
    };
    const snap = buildMultiSnapshot(row, 4000, TODAY);
    expect(snap.label).toBe("Davivienda *5678");
  });
});

// ---------------------------------------------------------------------------
// buildSingleSnapshot
// ---------------------------------------------------------------------------

describe("buildSingleSnapshot", () => {
  it("carries native currency on the snapshot", () => {
    const row: SingleCurrencyRow = {
      id: 99,
      name: "USD Card",
      institution: "Amex",
      currency: "USD",
      metadata: { creditLimitCents: 100_000, cutoffDay: 15 },
      userId: 2,
      balanceCents: BigInt(-80_000),
    };
    const snap = buildSingleSnapshot(row, 4000, TODAY);
    expect(snap.currency).toBe("USD");
    expect(snap.cardId).toBe("acc-99");
    expect(snap.kind).toBe("account");
  });

  it("usedCents is absolute of negative balance; zero when balance >= 0", () => {
    const rowDebt: SingleCurrencyRow = {
      id: 10,
      name: "COP Card",
      institution: "Bancolombia",
      currency: "COP",
      metadata: { creditLimitCents: 5_000_000 },
      userId: 1,
      balanceCents: BigInt(-2_000_000),
    };
    const snapDebt = buildSingleSnapshot(rowDebt, 4000, TODAY);
    expect(snapDebt.usedCents).toBe(BigInt(2_000_000));

    const rowCredit: SingleCurrencyRow = { ...rowDebt, balanceCents: BigInt(100_000) };
    const snapCredit = buildSingleSnapshot(rowCredit, 4000, TODAY);
    expect(snapCredit.usedCents).toBe(BigInt(0));
  });

  it("daysToCutoff is null when cutoffDay is null", () => {
    const row: SingleCurrencyRow = {
      id: 11,
      name: "No Cutoff",
      institution: "Nequi",
      currency: "COP",
      metadata: { creditLimitCents: 1_000_000 },
      userId: 1,
      balanceCents: BigInt(0),
    };
    const snap = buildSingleSnapshot(row, 4000, TODAY);
    expect(snap.daysToCutoff).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchUserTcSnapshots
// ---------------------------------------------------------------------------

describe("fetchUserTcSnapshots", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    rewireDbMock();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("returns empty array when no cards exist", async () => {
    mocks.dbMultiGroupBy.mockResolvedValueOnce([]);
    mocks.dbSingleWhere.mockResolvedValueOnce([]);

    const snaps = await fetchUserTcSnapshots(1, 4000, TODAY);
    expect(snaps).toEqual([]);
  });

  it("skips multi-currency cards with no cutoff AND zero limit", async () => {
    mocks.dbMultiGroupBy.mockResolvedValueOnce([
      {
        id: "skip",
        name: null,
        institution: "Banco",
        network: null,
        last4: null,
        // Drizzle returns bigint for this column; the map pass-through keeps it as-is
        creditLimitCents: BigInt(0),
        statementCutoffDay: null,
        userId: 1,
        copDebtCents: "0",
        usdDebtCents: "0",
      },
    ]);
    mocks.dbSingleWhere.mockResolvedValueOnce([]);

    const snaps = await fetchUserTcSnapshots(1, 4000, TODAY);
    expect(snaps).toHaveLength(0);
  });

  it("includes a multi-currency card that has a non-zero limit", async () => {
    mocks.dbMultiGroupBy.mockResolvedValueOnce([
      {
        id: "uuid-5",
        name: "Visa",
        institution: "Bancolombia",
        network: "visa",
        last4: "0001",
        creditLimitCents: BigInt(10_000_000),
        statementCutoffDay: null,
        userId: 1,
        copDebtCents: "-5000000",
        usdDebtCents: "0",
      },
    ]);
    mocks.dbSingleWhere.mockResolvedValueOnce([]);

    const snaps = await fetchUserTcSnapshots(1, 4000, TODAY);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.cardId).toBe("pc-uuid-5");
    expect(snaps[0]!.currency).toBe("COP");
  });
});
