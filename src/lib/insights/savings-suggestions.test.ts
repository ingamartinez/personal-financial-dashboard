import { describe, expect, it } from "vitest";
import {
  detectIdleSavings,
  computeCdtSuggestion,
  computeFicSuggestion,
  quarterLabel,
  IDLE_BALANCE_THRESHOLD_CENTS,
  type IdleSavingsAccount,
} from "./savings-suggestions";
import { CDT_RATES, FIC_YIELD, SAVINGS_BASELINE_YIELD } from "./cdt-fic-rates";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FX_RATE = 4000; // COP per USD

function makeIdleAccount(overrides: Partial<IdleSavingsAccount> = {}): IdleSavingsAccount {
  return {
    accountId: 1,
    avgBalanceCents: BigInt(10_000_000 * 100), // 10M COP
    currency: "COP",
    monthlyBurnCents: BigInt(500_000 * 100), // 500K COP/month burn
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// quarterLabel
// ---------------------------------------------------------------------------

describe("quarterLabel", () => {
  it("returns Q1 for January (month 0)", () => {
    expect(quarterLabel(new Date(2026, 0, 15))).toBe("Q1-2026");
  });

  it("returns Q1 for March (month 2)", () => {
    expect(quarterLabel(new Date(2026, 2, 31))).toBe("Q1-2026");
  });

  it("returns Q2 for April (month 3)", () => {
    expect(quarterLabel(new Date(2026, 3, 1))).toBe("Q2-2026");
  });

  it("returns Q2 for May (month 4)", () => {
    expect(quarterLabel(new Date(2026, 4, 2))).toBe("Q2-2026");
  });

  it("returns Q3 for July (month 6)", () => {
    expect(quarterLabel(new Date(2026, 6, 1))).toBe("Q3-2026");
  });

  it("returns Q4 for December (month 11)", () => {
    expect(quarterLabel(new Date(2026, 11, 31))).toBe("Q4-2026");
  });
});

// ---------------------------------------------------------------------------
// detectIdleSavings — eligibility
// ---------------------------------------------------------------------------

describe("detectIdleSavings — eligibility", () => {
  it("skips non-savings accounts (credit_card, loan)", () => {
    const result = detectIdleSavings({
      accounts: [
        {
          id: 1,
          type: "credit_card",
          currency: "COP",
          balanceCents: BigInt(20_000_000 * 100),
        },
        {
          id: 2,
          type: "loan",
          currency: "COP",
          balanceCents: BigInt(20_000_000 * 100),
        },
      ],
      txsLast90d: [],
      fxRate: FX_RATE,
    });

    expect(result).toHaveLength(0);
  });

  it("skips savings account below 5M COP threshold", () => {
    const result = detectIdleSavings({
      accounts: [
        {
          id: 1,
          type: "savings",
          currency: "COP",
          balanceCents: IDLE_BALANCE_THRESHOLD_CENTS - BigInt(1),
        },
      ],
      txsLast90d: [],
      fxRate: FX_RATE,
    });

    expect(result).toHaveLength(0);
  });

  it("includes savings account just above 5M COP threshold with net positive flow", () => {
    const result = detectIdleSavings({
      accounts: [
        {
          id: 1,
          type: "savings",
          currency: "COP",
          balanceCents: IDLE_BALANCE_THRESHOLD_CENTS + BigInt(1),
        },
      ],
      txsLast90d: [
        // Must have inflow > outflow to pass drain check
        { accountId: 1, amountCents: BigInt(1_000_000 * 100), currency: "COP" },
      ],
      fxRate: FX_RATE,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.accountId).toBe(1);
  });

  it("skips account being drained (outflow > inflow)", () => {
    const result = detectIdleSavings({
      accounts: [
        {
          id: 1,
          type: "savings",
          currency: "COP",
          balanceCents: BigInt(10_000_000 * 100),
        },
      ],
      txsLast90d: [
        // inflow: 1M
        { accountId: 1, amountCents: BigInt(1_000_000 * 100), currency: "COP" },
        // outflow: 3M (being drained)
        { accountId: 1, amountCents: BigInt(-3_000_000 * 100), currency: "COP" },
      ],
      fxRate: FX_RATE,
    });

    expect(result).toHaveLength(0);
  });

  it("skips account where inflow == outflow (not net positive)", () => {
    const result = detectIdleSavings({
      accounts: [
        {
          id: 1,
          type: "savings",
          currency: "COP",
          balanceCents: BigInt(10_000_000 * 100),
        },
      ],
      txsLast90d: [
        { accountId: 1, amountCents: BigInt(2_000_000 * 100), currency: "COP" },
        { accountId: 1, amountCents: BigInt(-2_000_000 * 100), currency: "COP" },
      ],
      fxRate: FX_RATE,
    });

    expect(result).toHaveLength(0);
  });

  it("includes account with more inflow than outflow", () => {
    const result = detectIdleSavings({
      accounts: [
        {
          id: 1,
          type: "savings",
          currency: "COP",
          balanceCents: BigInt(10_000_000 * 100),
        },
      ],
      txsLast90d: [
        { accountId: 1, amountCents: BigInt(5_000_000 * 100), currency: "COP" },
        { accountId: 1, amountCents: BigInt(-2_000_000 * 100), currency: "COP" },
      ],
      fxRate: FX_RATE,
    });

    expect(result).toHaveLength(1);
  });

  it("computes monthlyBurnCents as abs(outflow_90d) / 3", () => {
    const result = detectIdleSavings({
      accounts: [
        {
          id: 1,
          type: "savings",
          currency: "COP",
          balanceCents: BigInt(10_000_000 * 100),
        },
      ],
      txsLast90d: [
        { accountId: 1, amountCents: BigInt(5_000_000 * 100), currency: "COP" },
        // total outflow = 3M over 90d
        { accountId: 1, amountCents: BigInt(-1_500_000 * 100), currency: "COP" },
        { accountId: 1, amountCents: BigInt(-1_500_000 * 100), currency: "COP" },
      ],
      fxRate: FX_RATE,
    });

    expect(result).toHaveLength(1);
    // 3M / 3 = 1M per month
    expect(result[0]!.monthlyBurnCents).toBe(BigInt(1_000_000 * 100));
  });

  it("handles multiple accounts independently", () => {
    const result = detectIdleSavings({
      accounts: [
        {
          id: 1,
          type: "savings",
          currency: "COP",
          balanceCents: BigInt(10_000_000 * 100),
        },
        {
          id: 2,
          type: "savings",
          currency: "COP",
          balanceCents: BigInt(2_000_000 * 100), // below threshold
        },
      ],
      txsLast90d: [
        // account 1 is net positive
        { accountId: 1, amountCents: BigInt(5_000_000 * 100), currency: "COP" },
        { accountId: 1, amountCents: BigInt(-1_000_000 * 100), currency: "COP" },
      ],
      fxRate: FX_RATE,
    });

    // Only account 1 qualifies
    expect(result).toHaveLength(1);
    expect(result[0]!.accountId).toBe(1);
  });

  it("converts USD account balance to COP for threshold check", () => {
    // 1500 USD × 4000 = 6M COP — above 5M threshold
    const result = detectIdleSavings({
      accounts: [
        {
          id: 1,
          type: "savings",
          currency: "USD",
          balanceCents: BigInt(1_500 * 100), // 1500 USD
        },
      ],
      txsLast90d: [
        // inflow
        { accountId: 1, amountCents: BigInt(500 * 100), currency: "USD" },
        // outflow
        { accountId: 1, amountCents: BigInt(-100 * 100), currency: "USD" },
      ],
      fxRate: FX_RATE, // 4000
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.currency).toBe("USD");
    // avgBalanceCents stored in native USD
    expect(result[0]!.avgBalanceCents).toBe(BigInt(1_500 * 100));
  });

  it("skips USD account below threshold after FX conversion", () => {
    // 500 USD × 4000 = 2M COP — below 5M threshold
    const result = detectIdleSavings({
      accounts: [
        {
          id: 1,
          type: "savings",
          currency: "USD",
          balanceCents: BigInt(500 * 100), // 500 USD
        },
      ],
      txsLast90d: [{ accountId: 1, amountCents: BigInt(100 * 100), currency: "USD" }],
      fxRate: FX_RATE,
    });

    expect(result).toHaveLength(0);
  });

  it("ignores transactions from other accounts", () => {
    const result = detectIdleSavings({
      accounts: [
        {
          id: 1,
          type: "savings",
          currency: "COP",
          balanceCents: BigInt(10_000_000 * 100),
        },
      ],
      txsLast90d: [
        // These belong to account 2, not account 1
        { accountId: 2, amountCents: BigInt(-5_000_000 * 100), currency: "COP" },
        { accountId: 2, amountCents: BigInt(-5_000_000 * 100), currency: "COP" },
      ],
      fxRate: FX_RATE,
    });

    // Account 1 has zero outflows so inflow (0) === outflow (0) — NOT net positive
    // Actually no txs at all = inflow=0, outflow=0 — 0 <= 0 fails the check
    expect(result).toHaveLength(0);
  });

  it("includes account with zero outflows (purely inbound savings)", () => {
    const result = detectIdleSavings({
      accounts: [
        {
          id: 1,
          type: "savings",
          currency: "COP",
          balanceCents: BigInt(10_000_000 * 100),
        },
      ],
      txsLast90d: [
        // Only inflows, no outflows
        { accountId: 1, amountCents: BigInt(1_000_000 * 100), currency: "COP" },
        { accountId: 1, amountCents: BigInt(2_000_000 * 100), currency: "COP" },
      ],
      fxRate: FX_RATE,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.monthlyBurnCents).toBe(BigInt(0));
  });
});

// ---------------------------------------------------------------------------
// computeCdtSuggestion
// ---------------------------------------------------------------------------

describe("computeCdtSuggestion", () => {
  it("returns null when suggested amount is below 1M COP minimum", () => {
    // balance 5.5M, burn 2M/month → buffer = 3M, suggested = 2.5M > 1M — should pass
    // To get below 1M: small balance with large burn
    const account = makeIdleAccount({
      avgBalanceCents: BigInt(3_000_000 * 100), // 3M
      monthlyBurnCents: BigInt(1_500_000 * 100), // 1.5M/month → buffer = 2.25M
      // suggested = 3M - 2.25M = 0.75M < 1M → null
    });

    const result = computeCdtSuggestion(account, CDT_RATES);
    expect(result).toBeNull();
  });

  it("returns suggestion when amount meets minimum", () => {
    const account = makeIdleAccount({
      avgBalanceCents: BigInt(10_000_000 * 100),
      monthlyBurnCents: BigInt(500_000 * 100), // buffer = 750K
      // suggested = 10M - 750K = 9.25M > 1M → valid
    });

    const result = computeCdtSuggestion(account, CDT_RATES);
    expect(result).not.toBeNull();
    expect(result!.accountId).toBe(1);
    expect(result!.suggestedAmountCents).toBe(
      BigInt(10_000_000 * 100) - (BigInt(15) * BigInt(500_000 * 100)) / BigInt(10),
    );
  });

  it("generates 3 terms: 6M, 12M, 24M", () => {
    const account = makeIdleAccount();
    const result = computeCdtSuggestion(account, CDT_RATES);

    expect(result).not.toBeNull();
    expect(result!.terms).toHaveLength(3);
    expect(result!.terms.map((t) => t.months)).toEqual([6, 12, 24]);
  });

  it("computes correct yield for CDT 12M at 12.5%", () => {
    const account = makeIdleAccount({
      avgBalanceCents: BigInt(10_000_000 * 100), // 10M
      monthlyBurnCents: BigInt(0), // no burn
    });

    const result = computeCdtSuggestion(account, CDT_RATES);
    expect(result).not.toBeNull();

    const term12 = result!.terms.find((t) => t.months === 12)!;
    // 10M × 0.125 × 12/12 = 10M × 0.125 = 1.25M COP
    // BigInt: suggestedAmount × 125 × 12 / 12_000 = suggestedAmount × 125 / 1000
    const expected = (BigInt(10_000_000 * 100) * BigInt(125)) / BigInt(1_000);
    expect(term12.estimatedYieldCents).toBe(expected);
  });

  it("computes correct yield for CDT 6M at 11%", () => {
    const account = makeIdleAccount({
      avgBalanceCents: BigInt(10_000_000 * 100),
      monthlyBurnCents: BigInt(0),
    });

    const result = computeCdtSuggestion(account, CDT_RATES);
    const term6 = result!.terms.find((t) => t.months === 6)!;
    // 10M × 0.11 × 6/12 = 10M × 0.055 = 550K
    // BigInt: 10M × 110 × 6 / 12_000 = 10M × 660 / 12_000 = 10M × 11/200 = 550K
    const expected = (BigInt(10_000_000 * 100) * BigInt(110) * BigInt(6)) / BigInt(12_000);
    expect(term6.estimatedYieldCents).toBe(expected);
  });

  it("applies 1.5× monthly burn buffer correctly", () => {
    const account = makeIdleAccount({
      avgBalanceCents: BigInt(10_000_000 * 100),
      monthlyBurnCents: BigInt(2_000_000 * 100), // 2M/month
    });

    const result = computeCdtSuggestion(account, CDT_RATES);
    // buffer = 1.5 × 2M = 3M → suggested = 10M - 3M = 7M
    expect(result!.suggestedAmountCents).toBe(BigInt(7_000_000 * 100));
  });
});

// ---------------------------------------------------------------------------
// computeFicSuggestion
// ---------------------------------------------------------------------------

describe("computeFicSuggestion", () => {
  it("returns null when suggested amount is below 1M COP minimum", () => {
    const account = makeIdleAccount({
      avgBalanceCents: BigInt(3_000_000 * 100),
      monthlyBurnCents: BigInt(1_500_000 * 100),
    });

    const result = computeFicSuggestion(account, FIC_YIELD);
    expect(result).toBeNull();
  });

  it("returns FIC suggestion with annual yield", () => {
    const account = makeIdleAccount({
      avgBalanceCents: BigInt(10_000_000 * 100),
      monthlyBurnCents: BigInt(0),
    });

    const result = computeFicSuggestion(account, FIC_YIELD);
    expect(result).not.toBeNull();
    expect(result!.accountId).toBe(1);
    expect(result!.ratePct).toBe(8); // 0.08 × 100
  });

  it("computes correct annual yield at 8%", () => {
    const account = makeIdleAccount({
      avgBalanceCents: BigInt(10_000_000 * 100), // 10M COP
      monthlyBurnCents: BigInt(0),
    });

    const result = computeFicSuggestion(account, FIC_YIELD);
    // 10M × 0.08 = 800K
    // BigInt: 10M × 80 / 1_000 = 10M × 8/100 = 800K
    const expected = (BigInt(10_000_000 * 100) * BigInt(80)) / BigInt(1_000);
    expect(result!.estimatedYearlyYieldCents).toBe(expected);
  });

  it("FIC yield > savings baseline (8% > 6%) differential is positive", () => {
    const principal = BigInt(10_000_000 * 100);
    const ficYield = (principal * BigInt(Math.round(FIC_YIELD * 1000))) / BigInt(1_000);
    const baselineYield =
      (principal * BigInt(Math.round(SAVINGS_BASELINE_YIELD * 1000))) / BigInt(1_000);

    expect(ficYield).toBeGreaterThan(baselineYield);
  });

  it("uses same buffer logic as CDT", () => {
    const account = makeIdleAccount({
      avgBalanceCents: BigInt(10_000_000 * 100),
      monthlyBurnCents: BigInt(2_000_000 * 100),
    });

    const fic = computeFicSuggestion(account, FIC_YIELD);
    const cdt = computeCdtSuggestion(account, CDT_RATES);

    expect(fic!.suggestedAmountCents).toBe(cdt!.suggestedAmountCents);
  });
});
