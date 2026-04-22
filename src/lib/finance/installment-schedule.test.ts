import { describe, expect, it } from "vitest";
import { installmentSchedule, monthsBetween, periodInterestCents } from "./installment-schedule";

// #407: fixtures + invariants for the installment-schedule helper. Three
// anchors, each straight from real data per parent #345:
//
//   F1 — MercadoPago L on Bancolombia Visa *2575: 2_479_900 pesos at 1.8311%
//        EM × 12 cuotas, no grace. Extract dated feb-mar 2026. Capital per
//        period should be 206_658.33, so 206_658 cents + residue on cuota 12.
//
//   F2 — Diferido sin intereses: 1_049_900 pesos at 0% × 9 cuotas, no grace.
//        Capital uniform, interest zero, total-to-pay == amount.
//
//   F3 — Compra de cartera TDC Amex: 29_000_000 pesos at 1.39% EM × 60 cuotas
//        WITH month-1 grace. Source: `.private/statements/Simulacion_
//        CompraCartera_Amex_29M_1.39EM_60m.md` (gitignored — personal data).
//        The private doc rounds displays to pesos for legibility; the
//        assertions here tolerate ±100 cents per row to absorb that drift
//        and still catch semantic drift (missing grace, wrong bucket, etc).

describe("periodInterestCents", () => {
  it("returns 0 when rate is 0 (diferido sin intereses — regla 1)", () => {
    expect(periodInterestCents(BigInt(100_000_000), 0)).toBe(BigInt(0));
  });

  it("returns 0 when balance is 0 or negative", () => {
    expect(periodInterestCents(BigInt(0), 19110)).toBe(BigInt(0));
    expect(periodInterestCents(BigInt(-1), 19110)).toBe(BigInt(0));
  });

  it("rounds half-up — 2_851_666_667 cents × 13900 x10k ≈ 39_638_167 cents (1.39% EM)", () => {
    expect(periodInterestCents(BigInt("2851666667"), 13900)).toBe(BigInt("39638167"));
  });
});

describe("monthsBetween", () => {
  it("returns 0 for end == start", () => {
    const d = new Date("2026-04-15T00:00:00Z");
    expect(monthsBetween(d, d)).toBe(0);
  });

  it("returns 1 after one full calendar month", () => {
    expect(monthsBetween(new Date("2026-01-15"), new Date("2026-02-15"))).toBe(1);
  });

  it("does NOT count a month that hasn't hit the anniversary day yet", () => {
    expect(monthsBetween(new Date("2026-01-15"), new Date("2026-02-14"))).toBe(0);
  });

  it("handles year boundaries", () => {
    expect(monthsBetween(new Date("2025-12-15"), new Date("2026-03-15"))).toBe(3);
  });
});

describe("installmentSchedule — F1 (purchase 12 cuotas @ 1.8311% EM, no grace)", () => {
  // MercadoPago L line from the Visa *2575 extract (feb-mar 2026).
  // amountCents 2_479_900 * 100 = 247_990_000.
  const input = {
    amountCents: BigInt(247_990_000),
    rateEmX10k: 18311, // 1.8311% EM exact — the actual extract rate at 4-decimal precision
    installments: 12,
    graceMonth: false,
    purchaseDate: new Date("2026-02-15"),
    today: new Date("2026-04-15"),
  };
  const result = installmentSchedule(input);

  it("has N rows", () => {
    expect(result.rows.length).toBe(12);
  });

  it("capital per period is floor(amount / N) rounded to whole pesos, last absorbs residue", () => {
    // Helper rounds capital down to whole pesos (×100 cents) so Σ(capital)
    // matches what a Bancolombia extract prints.
    const PESO = BigInt(100);
    const expectedCapital = (input.amountCents / BigInt(12) / PESO) * PESO;
    const residue = input.amountCents - expectedCapital * BigInt(12);
    for (let i = 0; i < 11; i++) {
      expect(result.rows[i].capitalCents).toBe(expectedCapital);
    }
    expect(result.rows[11].capitalCents).toBe(expectedCapital + residue);
  });

  it("Σ(capitalCents) === amountCents exactly", () => {
    const total = result.rows.reduce((a, r) => a + r.capitalCents, BigInt(0));
    expect(total).toBe(input.amountCents);
  });

  it("balance decreases monotonically and hits 0 at month N", () => {
    let prev = input.amountCents;
    for (const row of result.rows) {
      expect(row.balanceAfterCents).toBeLessThan(prev);
      prev = row.balanceAfterCents;
    }
    expect(result.rows[result.rows.length - 1].balanceAfterCents).toBe(BigInt(0));
  });

  it("no deferred interest without graceMonth", () => {
    for (const row of result.rows) {
      expect(row.deferredInterestCents).toBe(BigInt(0));
    }
  });

  it("paid count: 2 months have passed between 2026-02-15 and 2026-04-15", () => {
    expect(result.paidCount).toBe(2);
    expect(result.pendingCount).toBe(10);
  });
});

describe("installmentSchedule — F2 (diferido sin intereses 9 cuotas @ 0%)", () => {
  const input = {
    amountCents: BigInt(104_990_000), // 1_049_900 pesos
    rateEmX10k: 0,
    installments: 9,
    graceMonth: false,
    purchaseDate: new Date("2026-01-10"),
    today: new Date("2026-04-10"),
  };
  const result = installmentSchedule(input);

  it("every interest is exactly 0", () => {
    expect(result.totalInterestCents).toBe(BigInt(0));
    for (const row of result.rows) {
      expect(row.interestCents).toBe(BigInt(0));
      expect(row.deferredInterestCents).toBe(BigInt(0));
    }
  });

  it("cuota === capital when rate is 0", () => {
    for (const row of result.rows) {
      expect(row.cuotaCents).toBe(row.capitalCents);
    }
  });

  it("Σ(cuotaCents) === amountCents", () => {
    const total = result.rows.reduce((a, r) => a + r.cuotaCents, BigInt(0));
    expect(total).toBe(input.amountCents);
  });
});

describe("installmentSchedule — F3 (compra de cartera 29M @ 1.39% EM × 60, graceMonth)", () => {
  const input = {
    amountCents: BigInt("2900000000"), // 29_000_000 COP
    rateEmX10k: 13900, // 1.39% EM exact at 4-decimal precision (#411)
    installments: 60,
    graceMonth: true,
    purchaseDate: new Date("2026-05-01"),
    today: new Date("2026-05-01"), // fresh — paidCount should be 0
  };
  const result = installmentSchedule(input);

  it("emits 60 rows", () => {
    expect(result.rows.length).toBe(60);
  });

  it("month 1 under grace pays only capital — no interest on the cuota", () => {
    const m1 = result.rows[0];
    expect(m1.interestCents).toBe(BigInt(0));
    expect(m1.deferredInterestCents).toBe(BigInt(0));
    expect(m1.cuotaCents).toBe(m1.capitalCents);
  });

  it("month 2 under grace absorbs the deferred month-1 interest", () => {
    const m2 = result.rows[1];
    // deferred = month-1 interest on the full amount
    expect(m2.deferredInterestCents).toBe(periodInterestCents(input.amountCents, 13900));
    // own interest computed on balance-entering-month-2 = amount - capital_m1
    const balanceM2Start = input.amountCents - result.rows[0].capitalCents;
    expect(m2.interestCents).toBe(periodInterestCents(balanceM2Start, 13900));
  });

  it("balance reaches 0 at month 60 (regla 5: last cuota absorbs residue)", () => {
    expect(result.rows[59].balanceAfterCents).toBe(BigInt(0));
  });

  it("Σ(capital) === amount", () => {
    const total = result.rows.reduce((a, r) => a + r.capitalCents, BigInt(0));
    expect(total).toBe(input.amountCents);
  });

  it("Σ(cuota) === amount + totalInterest (cash-flow identity)", () => {
    const totalCuotas = result.rows.reduce((a, r) => a + r.cuotaCents, BigInt(0));
    expect(totalCuotas).toBe(input.amountCents + result.totalInterestCents);
  });

  it("matches the private markdown fixture at ±100 cents per row (rows 1, 2, 3, 60)", () => {
    // Fixture values from `.private/statements/Simulacion_CompraCartera_
    // Amex_29M_1.39EM_60m.md` — re-expressed as cents for comparison. The
    // markdown rounds to pesos for display, hence the ±100 cent tolerance
    // on each row (roughly ±1 peso). We check rows at the critical anchors:
    // month 1 (capital only), month 2 (grace absorption), month 3 (first
    // normal month), month 60 (residue absorbed).
    const expectedPesos: Record<number, { capital: number; interest: number; cuota: number }> = {
      1: { capital: 483_333, interest: 0, cuota: 483_333 },
      // Month 2: markdown lumps `interest + deferred = 799_482` into one
      // column; we split them apart, so we check the sum instead.
      2: { capital: 483_333, interest: 799_482, cuota: 1_282_815 },
      3: { capital: 483_333, interest: 389_663, cuota: 872_996 },
      60: { capital: 483_353, interest: 6_719, cuota: 490_072 },
    };
    for (const [monthStr, exp] of Object.entries(expectedPesos)) {
      const month = Number(monthStr);
      const row = result.rows[month - 1];
      const tolCents = BigInt(100);
      const interestTotalCents = row.interestCents + row.deferredInterestCents;
      const expCapital = BigInt(exp.capital * 100);
      const expInterest = BigInt(exp.interest * 100);
      const expCuota = BigInt(exp.cuota * 100);
      expect(absDiff(row.capitalCents, expCapital)).toBeLessThanOrEqual(tolCents);
      expect(absDiff(interestTotalCents, expInterest)).toBeLessThanOrEqual(tolCents);
      expect(absDiff(row.cuotaCents, expCuota)).toBeLessThanOrEqual(tolCents);
    }
  });

  it("total paid over the life of the loan equals amount + Σ(per-row interest)", () => {
    // Note: the private markdown has an inconsistency — its "Total a pagar
    // $35.147.275 / Intereses totales $6.147.275" summary does NOT match the
    // per-row sum of interests in the same doc. Adding up the interest
    // column row by row gives ~$12.3M, matching this helper. We test the
    // invariant (identity of cash flows), not the buggy headline stat.
    const totalCuotas = result.rows.reduce((a, r) => a + r.cuotaCents, BigInt(0));
    expect(totalCuotas).toBe(input.amountCents + result.totalInterestCents);
  });

  it("paid / pending split reflects the today anchor", () => {
    expect(result.paidCount).toBe(0);
    expect(result.pendingCount).toBe(60);
  });
});

describe("installmentSchedule — edge cases", () => {
  it("N = 1 behaves as a single-payment purchase", () => {
    const result = installmentSchedule({
      amountCents: BigInt(100_000),
      rateEmX10k: 0,
      installments: 1,
      graceMonth: false,
      purchaseDate: new Date("2026-04-01"),
      today: new Date("2026-04-01"),
    });
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].capitalCents).toBe(BigInt(100_000));
    expect(result.rows[0].cuotaCents).toBe(BigInt(100_000));
    expect(result.totalInterestCents).toBe(BigInt(0));
  });

  it("`today` before `purchaseDate` yields paidCount = 0, not negative", () => {
    const result = installmentSchedule({
      amountCents: BigInt(100_000),
      rateEmX10k: 0,
      installments: 3,
      graceMonth: false,
      purchaseDate: new Date("2026-05-01"),
      today: new Date("2026-01-01"),
    });
    expect(result.paidCount).toBe(0);
  });

  it("`today` long after purchase caps paidCount at N", () => {
    const result = installmentSchedule({
      amountCents: BigInt(100_000),
      rateEmX10k: 0,
      installments: 3,
      graceMonth: false,
      purchaseDate: new Date("2020-01-01"),
      today: new Date("2026-04-01"),
    });
    expect(result.paidCount).toBe(3);
    expect(result.pendingCount).toBe(0);
  });

  it("throws on zero/negative amount", () => {
    expect(() =>
      installmentSchedule({
        amountCents: BigInt(0),
        rateEmX10k: 0,
        installments: 1,
        graceMonth: false,
        purchaseDate: new Date(),
        today: new Date(),
      }),
    ).toThrow();
  });

  it("throws on installments < 1 or > 240", () => {
    const base = {
      amountCents: BigInt(100),
      rateEmX10k: 0,
      graceMonth: false,
      purchaseDate: new Date(),
      today: new Date(),
    };
    expect(() => installmentSchedule({ ...base, installments: 0 })).toThrow();
    expect(() => installmentSchedule({ ...base, installments: 300 })).toThrow();
  });
});

function absDiff(a: bigint, b: bigint): bigint {
  const d = a - b;
  return d < BigInt(0) ? -d : d;
}
