// Tests for the tc-health-check BullMQ worker.
// The processor is tested directly — no Worker instantiation needed.
//
// After W1 (review fixup), the worker delegates all DB access to
// @/lib/insights/tc-health-queries. The mocks here reflect that boundary.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoist shared mock references so they work inside vi.mock factories.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  // @/lib/insights/tc-health-queries — four query/builder functions
  fetchMultiCurrencyCards: vi.fn(),
  fetchSingleCurrencyCards: vi.fn(),
  buildMultiSnapshot: vi.fn(),
  buildSingleSnapshot: vi.fn(),

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

vi.mock("@/lib/insights/tc-health-queries", () => ({
  fetchMultiCurrencyCards: mocks.fetchMultiCurrencyCards,
  fetchSingleCurrencyCards: mocks.fetchSingleCurrencyCards,
  buildMultiSnapshot: mocks.buildMultiSnapshot,
  buildSingleSnapshot: mocks.buildSingleSnapshot,
  nowInBogota: vi.fn(() => ({ year: 2026, month: 5, day: 1 })),
}));

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

vi.mock("@/lib/money", () => ({
  formatMoney: vi.fn((cents: bigint, currency: string) => `${currency} ${cents}`),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type { Job } from "bullmq";
import {
  tcHealthCheckProcessor,
  getCurrentYearMonth,
  type TcHealthCheckJobData,
} from "./tc-health-check";
import type { TcCardSnapshot } from "@/lib/insights/tc-health";

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

/** A minimal TcCardSnapshot for a multi-currency card at high utilization. */
function makeMultiSnap(overrides: Partial<TcCardSnapshot> = {}): TcCardSnapshot {
  return {
    cardId: "pc-uuid-card-1",
    kind: "physical",
    label: "Visa Premium",
    cutoffDay: null,
    currency: "COP",
    creditLimitCents: BigInt(10_000_000),
    usedCents: BigInt(9_500_000),
    utilizationPct: 95,
    daysToCutoff: null,
    ...overrides,
  };
}

/** A minimal TcCardSnapshot for a single-currency card with a statement approaching. */
function makeSingleSnap(overrides: Partial<TcCardSnapshot> = {}): TcCardSnapshot {
  return {
    cardId: "acc-42",
    kind: "account",
    label: "MasterCard (COP)",
    cutoffDay: 3,
    currency: "COP",
    creditLimitCents: BigInt(5_000_000),
    usedCents: BigInt(0),
    utilizationPct: 0,
    daysToCutoff: 2,
    ...overrides,
  };
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
    mocks.fetchMultiCurrencyCards.mockResolvedValueOnce([]);
    mocks.fetchSingleCurrencyCards.mockResolvedValueOnce([]);

    await expect(tcHealthCheckProcessor(makeJob())).resolves.toBeUndefined();
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 2: Multi-currency card with high utilization → emit util-95
  // -------------------------------------------------------------------------
  it("emits util-95 notification for a multi-currency card at 95% utilization", async () => {
    const snap = makeMultiSnap(); // 95%, no cutoff
    mocks.fetchMultiCurrencyCards.mockResolvedValueOnce([
      {
        id: "uuid-card-1",
        name: "Visa Premium",
        institution: "Bancolombia",
        network: "visa",
        last4: "1234",
        creditLimitCents: BigInt(10_000_000),
        statementCutoffDay: null,
        userId: 1,
        copDebtCents: BigInt(-9_500_000),
        usdDebtCents: BigInt(0),
      },
    ]);
    mocks.fetchSingleCurrencyCards.mockResolvedValueOnce([]);
    mocks.buildMultiSnapshot.mockReturnValue(snap);
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
    const snap = makeSingleSnap(); // daysToCutoff=2, util=0
    mocks.fetchMultiCurrencyCards.mockResolvedValueOnce([]);
    mocks.fetchSingleCurrencyCards.mockResolvedValueOnce([
      {
        id: 42,
        name: "MasterCard",
        institution: "Davivienda",
        currency: "COP",
        metadata: { creditLimitCents: 5_000_000, cutoffDay: 3 },
        userId: 2,
        balanceCents: BigInt(0),
      },
    ]);
    mocks.buildSingleSnapshot.mockReturnValue(snap);
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
    const snap = makeSingleSnap({ cardId: "acc-7", daysToCutoff: 1 });
    mocks.fetchMultiCurrencyCards.mockResolvedValueOnce([]);
    mocks.fetchSingleCurrencyCards.mockResolvedValueOnce([
      {
        id: 7,
        name: "Card",
        institution: "Nequi",
        currency: "COP",
        metadata: { creditLimitCents: 2_000_000, cutoffDay: 2 },
        userId: 3,
        balanceCents: BigInt(0),
      },
    ]);
    mocks.buildSingleSnapshot.mockReturnValue(snap);
    mocks.emitNotification.mockResolvedValue(null); // deduped

    await expect(tcHealthCheckProcessor(makeJob())).resolves.toBeUndefined();
    expect(mocks.emitNotification).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 5: Per-card emit failure is contained — other cards still process
  // -------------------------------------------------------------------------
  it("logs error and continues when one emit fails — other cards still fire", async () => {
    const snapA = makeSingleSnap({ cardId: "acc-1", cutoffDay: 2, daysToCutoff: 1 });
    const snapB = makeSingleSnap({ cardId: "acc-2", cutoffDay: 3, daysToCutoff: 2 });

    // Two different users — each has one card
    mocks.fetchMultiCurrencyCards.mockResolvedValueOnce([]);
    mocks.fetchSingleCurrencyCards.mockResolvedValueOnce([
      {
        id: 1,
        name: "Card A",
        institution: "Banco A",
        currency: "COP",
        metadata: { creditLimitCents: 1_000_000, cutoffDay: 2 },
        userId: 1,
        balanceCents: BigInt(0),
      },
      {
        id: 2,
        name: "Card B",
        institution: "Banco B",
        currency: "COP",
        metadata: { creditLimitCents: 1_000_000, cutoffDay: 3 },
        userId: 2,
        balanceCents: BigInt(0),
      },
    ]);
    mocks.buildSingleSnapshot.mockReturnValueOnce(snapA).mockReturnValueOnce(snapB);
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
    mocks.fetchMultiCurrencyCards.mockResolvedValueOnce([
      {
        id: "uuid-skip",
        name: null,
        institution: "Banco",
        network: null,
        last4: null,
        creditLimitCents: BigInt(0), // no cupo
        statementCutoffDay: null,
        userId: 1,
        copDebtCents: BigInt(0),
        usdDebtCents: BigInt(0),
      },
    ]);
    mocks.fetchSingleCurrencyCards.mockResolvedValueOnce([]);

    await tcHealthCheckProcessor(makeJob());
    expect(mocks.emitNotification).not.toHaveBeenCalled();
    // buildMultiSnapshot should never be called for a skipped card
    expect(mocks.buildMultiSnapshot).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 7: DB failure propagates for BullMQ retry
  // -------------------------------------------------------------------------
  it("propagates DB errors for BullMQ retry", async () => {
    mocks.fetchMultiCurrencyCards.mockRejectedValueOnce(new Error("connection refused"));

    await expect(tcHealthCheckProcessor(makeJob())).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Test 8: updateProgress called at start and done
  // -------------------------------------------------------------------------
  it("calls updateProgress at start and done", async () => {
    mocks.fetchMultiCurrencyCards.mockResolvedValueOnce([]);
    mocks.fetchSingleCurrencyCards.mockResolvedValueOnce([]);

    const job = makeJob();
    await tcHealthCheckProcessor(job);

    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: "fetching" }));
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ done: true }));
    expect(job.log).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 9 (NEW — reviewer gap): Combined triggers on one card → exactly 2
  // emitNotification calls with distinct entityIds (-statement and -util-90)
  //
  // Locks in the orchestrator-decided additive/distinct-entityId behavior.
  // A future refactor collapsing to a "both" trigger would break this test.
  // -------------------------------------------------------------------------
  it("emits exactly 2 notifications for a card that fires both util-90 and statement", async () => {
    // Card: 92% utilization AND cutoff in 2 days → util-90 + statement
    const snap = makeMultiSnap({
      cardId: "pc-combo",
      utilizationPct: 92,
      usedCents: BigInt(9_200_000),
      creditLimitCents: BigInt(10_000_000),
      daysToCutoff: 2,
      cutoffDay: 3,
      currency: "COP",
    });

    mocks.fetchMultiCurrencyCards.mockResolvedValueOnce([
      {
        id: "combo",
        name: "Combo Card",
        institution: "Bancolombia",
        network: "visa",
        last4: "9999",
        creditLimitCents: BigInt(10_000_000),
        statementCutoffDay: 3,
        userId: 5,
        copDebtCents: BigInt(-9_200_000),
        usdDebtCents: BigInt(0),
      },
    ]);
    mocks.fetchSingleCurrencyCards.mockResolvedValueOnce([]);
    mocks.buildMultiSnapshot.mockReturnValue(snap);
    mocks.emitNotification.mockResolvedValue({ id: 100 });

    await tcHealthCheckProcessor(makeJob());

    // Must have exactly 2 calls for the same card
    expect(mocks.emitNotification).toHaveBeenCalledTimes(2);

    const entityIds = (mocks.emitNotification.mock.calls as [number, { entityId: string }][]).map(
      ([_uid, input]) => input.entityId,
    );

    // One ends in -util-90, the other in -statement
    expect(entityIds.some((id: string) => id.endsWith("-util-90"))).toBe(true);
    expect(entityIds.some((id: string) => id.endsWith("-statement"))).toBe(true);

    // Both are for the same card
    expect(entityIds.every((id: string) => id.includes("pc-combo"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildNotificationText — payment suggestion (W2)
//
// Tested indirectly via tcHealthCheckProcessor by inspecting the `body`
// passed to emitNotification.
// ---------------------------------------------------------------------------

describe("buildNotificationText — util body", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getCurrentFxRate.mockResolvedValue({ rate: 4000, source: "db", fetchedAt: new Date() });
  });

  it("body includes payment suggestion when paymentNeeded > 0", async () => {
    // 92% of 10_000_000 = 9_200_000 used
    // targetCents = 70% of 10_000_000 = 7_000_000
    // paymentNeeded = 9_200_000 - 7_000_000 = 2_200_000
    const snap = makeMultiSnap({
      cardId: "pc-pay-test",
      utilizationPct: 92,
      usedCents: BigInt(9_200_000),
      creditLimitCents: BigInt(10_000_000),
      daysToCutoff: null,
      currency: "COP",
    });

    mocks.fetchMultiCurrencyCards.mockResolvedValueOnce([
      {
        id: "pay-test",
        name: "Pay Card",
        institution: "Banco",
        network: null,
        last4: null,
        creditLimitCents: BigInt(10_000_000),
        statementCutoffDay: null,
        userId: 1,
        copDebtCents: BigInt(-9_200_000),
        usdDebtCents: BigInt(0),
      },
    ]);
    mocks.fetchSingleCurrencyCards.mockResolvedValueOnce([]);
    mocks.buildMultiSnapshot.mockReturnValue(snap);
    mocks.emitNotification.mockResolvedValue({ id: 50 });

    await tcHealthCheckProcessor(makeJob());

    expect(mocks.emitNotification).toHaveBeenCalledOnce();
    const [, input] = mocks.emitNotification.mock.calls[0] as [number, { body: string }];
    expect(input.body).toContain("para bajar al 70%");
  });

  it("body does NOT include payment suggestion when paymentNeeded would be 0 (exactly 70% used)", async () => {
    // Exactly 70% of 10_000_000 = 7_000_000 used → paymentNeeded = 0
    // But utilizationPct=80 so it triggers util-80
    const snap = makeMultiSnap({
      cardId: "pc-exact-70",
      utilizationPct: 80,
      usedCents: BigInt(7_000_000),
      creditLimitCents: BigInt(10_000_000),
      daysToCutoff: null,
      currency: "COP",
    });

    mocks.fetchMultiCurrencyCards.mockResolvedValueOnce([
      {
        id: "exact-70",
        name: "Exact Card",
        institution: "Banco",
        network: null,
        last4: null,
        creditLimitCents: BigInt(10_000_000),
        statementCutoffDay: null,
        userId: 1,
        copDebtCents: BigInt(-8_000_000),
        usdDebtCents: BigInt(0),
      },
    ]);
    mocks.fetchSingleCurrencyCards.mockResolvedValueOnce([]);
    mocks.buildMultiSnapshot.mockReturnValue(snap);
    mocks.emitNotification.mockResolvedValue({ id: 51 });

    await tcHealthCheckProcessor(makeJob());

    expect(mocks.emitNotification).toHaveBeenCalledOnce();
    const [, input] = mocks.emitNotification.mock.calls[0] as [number, { body: string }];
    // paymentNeeded = 7_000_000 - 7_000_000 = 0, so no suggestion
    expect(input.body).not.toContain("para bajar al 70%");
  });
});
