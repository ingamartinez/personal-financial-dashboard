import { describe, expect, it } from "vitest";
import {
  emToEa,
  eaToEm,
  emX10kToEa,
  EM_X10K_PER_FRACTIONAL,
  EM_X10K_SCALE,
  formatEmX10kAsEaPercent,
  formatEmX10kAsPercent,
  MAX_EM_X10K,
  MIN_NON_ZERO_EM_X10K,
  parsePercentToEmX10k,
  rateValidationMessage,
  resolveBucketRateX10k,
  validateInstallmentRate,
} from "./rates";

describe("rates: EM ↔ EA conversion", () => {
  it("EM 0% is EA 0%", () => {
    expect(emToEa(0)).toBe(0);
    expect(eaToEm(0)).toBe(0);
  });

  it("EM 1.9110% ≈ EA 25.50% (Bancolombia's 2-36 cuota bucket at 4 decimals)", () => {
    const ea = emToEa(0.01911);
    // Exact: (1.019110)^12 - 1 ≈ 0.25503 → 25.50% rounded
    expect(ea).toBeCloseTo(0.25503, 4);
  });

  it("round-trip: eaToEm ∘ emToEa ≈ identity", () => {
    for (const em of [0.005, 0.01, 0.01911, 0.05]) {
      expect(eaToEm(emToEa(em))).toBeCloseTo(em, 10);
    }
  });

  it("emX10kToEa(19110) matches the 4-decimal Bancolombia extract display", () => {
    // 19110 stored (percent × 10000) = 1.9110% EM → ~25.50% EA
    expect(emX10kToEa(19110)).toBeCloseTo(0.25503, 4);
  });

  it("EM_X10K_PER_FRACTIONAL exports the divisor so callers don't invent scale factors", () => {
    expect(EM_X10K_PER_FRACTIONAL).toBe(1_000_000);
    expect(EM_X10K_SCALE).toBe(10000);
  });
});

describe("rates: formatters", () => {
  it("formatEmX10kAsPercent keeps 4 decimals for lossless display", () => {
    expect(formatEmX10kAsPercent(19110)).toBe("1.9110%");
    expect(formatEmX10kAsPercent(18311)).toBe("1.8311%");
    expect(formatEmX10kAsPercent(0)).toBe("0.0000%");
  });

  it("formatEmX10kAsEaPercent prints the EA equivalent at 2 decimals", () => {
    // 19110 stored = 1.9110% EM → 25.5026% EA → 25.50% rounded
    expect(formatEmX10kAsEaPercent(19110)).toBe("25.50%");
    expect(formatEmX10kAsEaPercent(0)).toBe("0.00%");
  });
});

describe("rates: parsePercentToEmX10k", () => {
  it("parses 4-decimal percent to the exact stored unit", () => {
    expect(parsePercentToEmX10k("1.9110")).toBe(19110);
    expect(parsePercentToEmX10k("0")).toBe(0);
    expect(parsePercentToEmX10k("25.5")).toBe(255000);
  });

  it("accepts comma as decimal separator and strips the % suffix", () => {
    expect(parsePercentToEmX10k("1,9110%")).toBe(19110);
    expect(parsePercentToEmX10k("1,91")).toBe(19100);
  });

  it("rejects negative, NaN, and empty", () => {
    expect(parsePercentToEmX10k("-1")).toBeNull();
    expect(parsePercentToEmX10k("abc")).toBeNull();
    expect(parsePercentToEmX10k("   ")).toBeNull();
  });
});

describe("rates: validateInstallmentRate", () => {
  it("accepts 0 (diferido sin intereses — regla 1 de #345)", () => {
    expect(validateInstallmentRate(0)).toEqual({ ok: true });
  });

  it("accepts typical TC rates at 4-decimal precision", () => {
    // 19110 stored = 1.9110% EM, the canonical Bancolombia bucket.
    expect(validateInstallmentRate(19110)).toEqual({ ok: true });
    // Avance/mora at some banks ~2-3% EM.
    expect(validateInstallmentRate(25000)).toEqual({ ok: true });
    expect(validateInstallmentRate(MIN_NON_ZERO_EM_X10K)).toEqual({ ok: true });
  });

  it("rejects non-zero values < MIN_NON_ZERO_EM_X10K (likely EA mislabeled as EM)", () => {
    // 191 stored = 0.0191% EM — this is what a legacy bps value would look
    // like if someone forgot to rescale after #411.
    expect(validateInstallmentRate(191)).toEqual({ ok: false, reason: "too-low" });
    // 2500 stored = 0.25% EM — also ambiguous / too low.
    expect(validateInstallmentRate(2500)).toEqual({ ok: false, reason: "too-low" });
  });

  it("rejects negative", () => {
    expect(validateInstallmentRate(-100)).toEqual({ ok: false, reason: "negative" });
  });

  it("rejects ≥ 100% EM (almost certainly a typo)", () => {
    expect(validateInstallmentRate(MAX_EM_X10K)).toEqual({ ok: false, reason: "too-high" });
    expect(validateInstallmentRate(9_999_999)).toEqual({ ok: false, reason: "too-high" });
  });

  it("rejects non-integers", () => {
    expect(validateInstallmentRate(19110.5)).toEqual({ ok: false, reason: "not-integer" });
  });

  it("messages mention EM vs EA explicitly for too-low (most common mistake)", () => {
    const msg = rateValidationMessage("too-low");
    expect(msg).toMatch(/EM/);
    expect(msg).toMatch(/EA/);
  });
});

describe("rates: resolveBucketRateX10k", () => {
  const buckets = { oneMonth: 0, months2to36: 19110, advances: 19110 };

  it("returns oneMonth bucket when installments = 1", () => {
    expect(resolveBucketRateX10k(buckets, 1)).toBe(0);
  });

  it("returns months2to36 bucket for [2, 36]", () => {
    expect(resolveBucketRateX10k(buckets, 2)).toBe(19110);
    expect(resolveBucketRateX10k(buckets, 12)).toBe(19110);
    expect(resolveBucketRateX10k(buckets, 36)).toBe(19110);
  });

  it("returns months2to36 bucket for > 36 installments (no distinct bucket in the extract)", () => {
    expect(resolveBucketRateX10k(buckets, 60)).toBe(19110);
  });

  it("returns the advances bucket when isAdvance=true regardless of installments", () => {
    expect(resolveBucketRateX10k(buckets, 1, true)).toBe(19110);
  });

  it("returns null when buckets are undefined / missing the relevant bucket", () => {
    expect(resolveBucketRateX10k(undefined, 12)).toBeNull();
    expect(resolveBucketRateX10k({ months2to36: 19110 }, 1)).toBeNull();
  });
});
