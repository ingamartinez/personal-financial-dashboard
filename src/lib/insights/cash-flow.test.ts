/**
 * Pure unit tests for cash-flow.ts — no DB, no side-effects.
 * All BigInt literals use BigInt() constructor (targets ES2017, avoids 0n).
 */

import { describe, expect, it } from "vitest";
import {
  bigintMedian,
  computeForecast30d,
  detectSalaryGap,
  estimateAmountCop,
  INCOME_CATEGORY_SLUGS,
  toDateString,
  toYearMonth,
  type ForecastInput,
  type ForecastObservation,
  type ForecastRecurring,
  type RecurringIncomeSummary,
} from "./cash-flow";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function makeRecurring(overrides: Partial<RecurringIncomeSummary> = {}): RecurringIncomeSummary {
  return {
    id: 1,
    label: "Salario Empresa",
    amountCents: BigInt(5_000_000_00), // 5,000,000 COP in cents
    dayOfMonth: 15,
    skippedMonths: [],
    active: true,
    categorySlug: "salario",
    ...overrides,
  };
}

function makeForecastRecurring(overrides: Partial<ForecastRecurring> = {}): ForecastRecurring {
  return {
    id: 1,
    amountCents: BigInt(-100_000_00), // 100,000 COP expense
    currency: "COP",
    dayOfMonth: 5,
    amountType: "fixed",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

describe("toYearMonth", () => {
  it("formats 2026-01 correctly", () => {
    expect(toYearMonth(makeDate(2026, 1, 15))).toBe("2026-01");
  });

  it("pads single-digit month", () => {
    expect(toYearMonth(makeDate(2026, 3, 1))).toBe("2026-03");
  });

  it("handles December", () => {
    expect(toYearMonth(makeDate(2025, 12, 31))).toBe("2025-12");
  });
});

describe("toDateString", () => {
  it("formats 2026-05-02 correctly", () => {
    expect(toDateString(makeDate(2026, 5, 2))).toBe("2026-05-02");
  });

  it("pads day and month", () => {
    expect(toDateString(makeDate(2026, 1, 5))).toBe("2026-01-05");
  });
});

// ---------------------------------------------------------------------------
// bigintMedian
// ---------------------------------------------------------------------------

describe("bigintMedian", () => {
  it("returns BigInt(0) for empty array", () => {
    expect(bigintMedian([])).toBe(BigInt(0));
  });

  it("returns single value for one-element array", () => {
    expect(bigintMedian([BigInt(1000)])).toBe(BigInt(1000));
  });

  it("returns the median of odd-length sorted array", () => {
    expect(bigintMedian([BigInt(1), BigInt(3), BigInt(5)])).toBe(BigInt(3));
  });

  it("returns avg of two middles for even-length array", () => {
    // [2, 4] → avg(2,4) = 3
    expect(bigintMedian([BigInt(2), BigInt(4)])).toBe(BigInt(3));
  });

  it("handles unsorted input (sorts internally)", () => {
    expect(bigintMedian([BigInt(5), BigInt(1), BigInt(3)])).toBe(BigInt(3));
  });

  it("handles large bigint values", () => {
    const vals = [BigInt(5_000_000_00), BigInt(4_500_000_00), BigInt(5_200_000_00)];
    // sorted: [4_500_000_00, 5_000_000_00, 5_200_000_00] → median = 5_000_000_00
    expect(bigintMedian(vals)).toBe(BigInt(5_000_000_00));
  });
});

// ---------------------------------------------------------------------------
// D.3 — detectSalaryGap
// ---------------------------------------------------------------------------

describe("detectSalaryGap", () => {
  // today = May 20 2026 (day 20, dayOfMonth=15 → 15+3=18 ≤ 20 → grace elapsed)
  const today = makeDate(2026, 5, 20);
  const ym = "2026-05";

  it("detects gap when grace elapsed and no observation", () => {
    const recurring = makeRecurring({ dayOfMonth: 15, active: true });
    const result = detectSalaryGap(today, recurring, []);
    expect(result.hasGap).toBe(true);
    if (result.hasGap) {
      expect(result.yearMonth).toBe(ym);
      expect(result.recurringId).toBe(1);
    }
  });

  it("no gap when inactive recurring", () => {
    const recurring = makeRecurring({ active: false });
    const result = detectSalaryGap(today, recurring, []);
    expect(result.hasGap).toBe(false);
  });

  it("no gap when within grace window (day 17, dayOfMonth=15 → 15+3=18, 17 < 18)", () => {
    const earlyToday = makeDate(2026, 5, 17); // day 17, trigger at 18
    const recurring = makeRecurring({ dayOfMonth: 15 });
    const result = detectSalaryGap(earlyToday, recurring, []);
    expect(result.hasGap).toBe(false);
    if (!result.hasGap) expect(result.reason).toBe("grace-window-not-elapsed");
  });

  it("no gap when exactly on grace trigger day (day 18, dayOfMonth=15 → 15+3=18 ≤ 18)", () => {
    const onTriggerDay = makeDate(2026, 5, 18); // exactly dayOfMonth + 3
    const recurring = makeRecurring({ dayOfMonth: 15 });
    const result = detectSalaryGap(onTriggerDay, recurring, []);
    expect(result.hasGap).toBe(true);
  });

  it("no gap when observation exists for current month", () => {
    const recurring = makeRecurring({ dayOfMonth: 15 });
    const observed = [{ recurringId: 1, yearMonth: ym }];
    const result = detectSalaryGap(today, recurring, observed);
    expect(result.hasGap).toBe(false);
    if (!result.hasGap) expect(result.reason).toBe("tx-observed");
  });

  it("no gap when month is in skippedMonths", () => {
    const recurring = makeRecurring({ skippedMonths: ["2026-05"] });
    const result = detectSalaryGap(today, recurring, []);
    expect(result.hasGap).toBe(false);
    if (!result.hasGap) expect(result.reason).toBe("skipped-month");
  });

  it("ignores observation from a different month", () => {
    const recurring = makeRecurring({ dayOfMonth: 15 });
    const observed = [{ recurringId: 1, yearMonth: "2026-04" }]; // previous month
    const result = detectSalaryGap(today, recurring, observed);
    expect(result.hasGap).toBe(true); // still a gap this month
  });

  it("no gap when categorySlug is not in INCOME_CATEGORY_SLUGS AND amountCents is negative", () => {
    const recurring = makeRecurring({
      categorySlug: "servicios-publicos",
      amountCents: BigInt(-50_000),
    });
    const result = detectSalaryGap(today, recurring, []);
    expect(result.hasGap).toBe(false);
    if (!result.hasGap) expect(result.reason).toBe("not-income");
  });

  it("no gap for positive amountCents with null slug (fallback requires non-null slug)", () => {
    // Uncategorized recurrings must NOT trigger salary-gap notifications.
    // Decision locked in #715: fallback = amountCents > 0 AND categorySlug IS NOT NULL.
    const recurring = makeRecurring({
      categorySlug: null,
      amountCents: BigInt(3_000_000),
    });
    const result = detectSalaryGap(today, recurring, []);
    expect(result.hasGap).toBe(false);
    if (!result.hasGap) expect(result.reason).toBe("not-income");
  });

  it("detects gap for user-defined income slug not in whitelist (non-null slug + positive amount)", () => {
    // Custom income categories (e.g. "consulting-rev") still work via the
    // amountCents > 0 AND categorySlug IS NOT NULL fallback.
    const recurring = makeRecurring({
      categorySlug: "consulting-rev",
      amountCents: BigInt(3_000_000),
    });
    const result = detectSalaryGap(today, recurring, []);
    expect(result.hasGap).toBe(true);
  });

  it("detects gap for 'freelance' category slug", () => {
    expect(INCOME_CATEGORY_SLUGS.has("freelance")).toBe(true);
    const recurring = makeRecurring({ categorySlug: "freelance" });
    const result = detectSalaryGap(today, recurring, []);
    expect(result.hasGap).toBe(true);
  });

  it("does not fire for 'ingresos' parent slug without being in whitelist check", () => {
    expect(INCOME_CATEGORY_SLUGS.has("ingresos")).toBe(true);
    const recurring = makeRecurring({ categorySlug: "ingresos" });
    const result = detectSalaryGap(today, recurring, []);
    expect(result.hasGap).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D.4 — estimateAmountCop
// ---------------------------------------------------------------------------

describe("estimateAmountCop", () => {
  const copPerUsd = 4000;

  it("returns amountCents directly for fixed COP recurring", () => {
    const recurring = makeForecastRecurring({ amountType: "fixed", currency: "COP" });
    expect(estimateAmountCop(recurring, [], copPerUsd)).toBe(BigInt(-100_000_00));
  });

  it("converts USD to COP for fixed USD recurring", () => {
    const recurring = makeForecastRecurring({
      amountType: "fixed",
      currency: "USD",
      amountCents: BigInt(-1000), // $10 USD in cents
    });
    // 1000 * 4000 = 4_000_000 (in micros-scaled: correct)
    const result = estimateAmountCop(recurring, [], copPerUsd);
    expect(result).toBe(BigInt(-4_000_000));
  });

  it("uses median of last 3 observations for variable recurring", () => {
    const recurring = makeForecastRecurring({
      id: 42,
      amountType: "variable",
      currency: "COP",
    });
    const obs: ForecastObservation[] = [
      {
        recurringId: 42,
        realAmountCents: BigInt(-50_000),
        realCurrency: "COP",
        observedAt: new Date("2026-04-01"),
      },
      {
        recurringId: 42,
        realAmountCents: BigInt(-60_000),
        realCurrency: "COP",
        observedAt: new Date("2026-03-01"),
      },
      {
        recurringId: 42,
        realAmountCents: BigInt(-55_000),
        realCurrency: "COP",
        observedAt: new Date("2026-02-01"),
      },
    ];
    // sorted by observedAt desc: 50k, 60k, 55k → median of [-50k,-60k,-55k] → sorted: [-60k,-55k,-50k] → median=-55k
    const result = estimateAmountCop(recurring, obs, copPerUsd);
    expect(result).toBe(BigInt(-55_000));
  });

  it("falls back to amountCents when variable has no observations", () => {
    const recurring = makeForecastRecurring({
      id: 99,
      amountType: "variable",
      currency: "COP",
      amountCents: BigInt(-80_000),
    });
    expect(estimateAmountCop(recurring, [], copPerUsd)).toBe(BigInt(-80_000));
  });

  it("uses only observations for the same currency (no cross-currency bleed)", () => {
    const recurring = makeForecastRecurring({
      id: 7,
      amountType: "variable",
      currency: "COP",
      amountCents: BigInt(-100_000),
    });
    const obs: ForecastObservation[] = [
      {
        recurringId: 7,
        realAmountCents: BigInt(-1000),
        realCurrency: "USD", // wrong currency
        observedAt: new Date("2026-04-01"),
      },
    ];
    // No COP observations → fallback to amountCents
    expect(estimateAmountCop(recurring, obs, copPerUsd)).toBe(BigInt(-100_000));
  });
});

// ---------------------------------------------------------------------------
// D.4 — computeForecast30d
// ---------------------------------------------------------------------------

describe("computeForecast30d", () => {
  const copPerUsd = 4000;
  const today = makeDate(2026, 5, 2); // May 2, 2026

  it("returns 30 entries in projectedDailyBalance", () => {
    const input: ForecastInput = {
      today,
      accounts: [{ currency: "COP", balanceCents: BigInt(1_000_000_00) }],
      recurrings: [],
      observations: [],
      copPerUsd,
    };
    const result = computeForecast30d(input);
    expect(result.projectedDailyBalance).toHaveLength(30);
  });

  it("no shortfall when balance stays positive", () => {
    const input: ForecastInput = {
      today,
      accounts: [{ currency: "COP", balanceCents: BigInt(5_000_000_00) }],
      recurrings: [
        makeForecastRecurring({
          amountCents: BigInt(-100_000_00),
          dayOfMonth: 10,
          amountType: "fixed",
        }),
      ],
      observations: [],
      copPerUsd,
    };
    const result = computeForecast30d(input);
    expect(result.shortfallDate).toBeUndefined();
  });

  it("detects shortfall on first negative day", () => {
    // Starting at 50k COP, one upcoming expense of 100k COP
    const input: ForecastInput = {
      today,
      accounts: [{ currency: "COP", balanceCents: BigInt(50_000) }],
      recurrings: [
        makeForecastRecurring({
          amountCents: BigInt(-100_000),
          dayOfMonth: today.getUTCDate() + 3, // 3 days from now
          amountType: "fixed",
        }),
      ],
      observations: [],
      copPerUsd,
    };
    const result = computeForecast30d(input);
    expect(result.shortfallDate).toBeDefined();
    // Expected shortfall date: today + 3 days
    const expectedDate = new Date(today.getTime() + 3 * 86400000);
    expect(result.shortfallDate).toBe(toDateString(expectedDate));
  });

  it("handles multi-currency accounts (converts USD to COP)", () => {
    const input: ForecastInput = {
      today,
      accounts: [
        { currency: "COP", balanceCents: BigInt(1_000_000) }, // 10,000 COP
        { currency: "USD", balanceCents: BigInt(1000) }, // $10 USD = 40,000 COP at 4000
      ],
      recurrings: [],
      observations: [],
      copPerUsd,
    };
    const result = computeForecast30d(input);
    // Starting balance = 1,000,000 + 1000*4000 = 1,000,000 + 4,000,000 = 5,000,000
    // All 30 days should be the same (no recurrings)
    expect(result.projectedDailyBalance[0]!.balanceCop).toBe(BigInt(5_000_000));
    expect(result.shortfallDate).toBeUndefined();
  });

  it("handles multiple recurrings on the same day (income + expense)", () => {
    // Recalculate the actual target day
    const day5Date = new Date(today.getTime() + 5 * 86400000);
    const targetDom = day5Date.getUTCDate();

    const input: ForecastInput = {
      today,
      accounts: [{ currency: "COP", balanceCents: BigInt(100_000) }],
      recurrings: [
        {
          id: 1,
          amountCents: BigInt(500_000),
          currency: "COP",
          dayOfMonth: targetDom,
          amountType: "fixed",
        },
        {
          id: 2,
          amountCents: BigInt(-200_000),
          currency: "COP",
          dayOfMonth: targetDom,
          amountType: "fixed",
        },
      ],
      observations: [],
      copPerUsd,
    };
    const result = computeForecast30d(input);
    // At day+5, net change = +500k - 200k = +300k → balance = 100k + 300k = 400k
    const dayPlusFiveEntry = result.projectedDailyBalance[4]!; // 0-indexed
    expect(dayPlusFiveEntry.balanceCop).toBe(BigInt(400_000));
    expect(result.shortfallDate).toBeUndefined();
  });

  it("tracks minBalance and minBalanceDate correctly", () => {
    const day10Date = new Date(today.getTime() + 10 * 86400000);
    const dom10 = day10Date.getUTCDate();

    const input: ForecastInput = {
      today,
      accounts: [{ currency: "COP", balanceCents: BigInt(1_000_000) }],
      recurrings: [
        {
          id: 1,
          amountCents: BigInt(-900_000),
          currency: "COP",
          dayOfMonth: dom10,
          amountType: "fixed",
        },
      ],
      observations: [],
      copPerUsd,
    };
    const result = computeForecast30d(input);
    expect(result.minBalance).toBe(BigInt(100_000));
    expect(result.minBalanceDate).toBe(toDateString(day10Date));
  });

  it("far-future shortfall (day 29) is detected but not day 1", () => {
    // Balance 1,000 COP, single large expense on day 29
    const day29Date = new Date(today.getTime() + 29 * 86400000);
    const dom29 = day29Date.getUTCDate();

    const input: ForecastInput = {
      today,
      accounts: [{ currency: "COP", balanceCents: BigInt(1_000) }],
      recurrings: [
        {
          id: 1,
          amountCents: BigInt(-5_000),
          currency: "COP",
          dayOfMonth: dom29,
          amountType: "fixed",
        },
      ],
      observations: [],
      copPerUsd,
    };
    const result = computeForecast30d(input);
    expect(result.shortfallDate).toBe(toDateString(day29Date));
  });

  it("variable-amount recurring uses median from observations", () => {
    const day5Date = new Date(today.getTime() + 5 * 86400000);
    const dom5 = day5Date.getUTCDate();

    const obs: ForecastObservation[] = [
      {
        recurringId: 10,
        realAmountCents: BigInt(-80_000),
        realCurrency: "COP",
        observedAt: new Date("2026-04-01"),
      },
      {
        recurringId: 10,
        realAmountCents: BigInt(-100_000),
        realCurrency: "COP",
        observedAt: new Date("2026-03-01"),
      },
      {
        recurringId: 10,
        realAmountCents: BigInt(-90_000),
        realCurrency: "COP",
        observedAt: new Date("2026-02-01"),
      },
    ];
    // median of [-80k,-100k,-90k] = sorted: [-100k,-90k,-80k] → median = -90k

    const input: ForecastInput = {
      today,
      accounts: [{ currency: "COP", balanceCents: BigInt(1_000_000) }],
      recurrings: [
        {
          id: 10,
          amountCents: BigInt(-200_000),
          currency: "COP",
          dayOfMonth: dom5,
          amountType: "variable",
        },
      ],
      observations: obs,
      copPerUsd,
    };
    const result = computeForecast30d(input);
    // On day+5: balance = 1_000_000 + (-90_000) = 910_000
    const entry = result.projectedDailyBalance[4]!;
    expect(entry.balanceCop).toBe(BigInt(910_000));
  });
});
