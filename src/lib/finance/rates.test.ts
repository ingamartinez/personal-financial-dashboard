import { describe, expect, it } from "vitest";
import {
  bpsEmToEa,
  eaToEm,
  emToEa,
  formatBpsEmAsEaPercent,
  formatBpsEmAsPercent,
  MAX_EM_BPS,
  MIN_NON_ZERO_EM_BPS,
  parsePercentToBps,
  rateValidationMessage,
  resolveBucketRateBps,
  validateInstallmentRateBps,
} from "./rates";

describe("rates: EM ↔ EA conversion", () => {
  it("EM 0% is EA 0%", () => {
    expect(emToEa(0)).toBe(0);
    expect(eaToEm(0)).toBe(0);
  });

  it("EM 1.91% ≈ EA 25.49% (Bancolombia's 2-36 cuota bucket)", () => {
    const ea = emToEa(0.0191);
    // Exact: (1.0191)^12 - 1 ≈ 0.25488 → 25.49% rounded
    expect(ea).toBeCloseTo(0.25488, 4);
  });

  it("round-trip: eaToEm ∘ emToEa ≈ identity", () => {
    for (const em of [0.005, 0.01, 0.0191, 0.05]) {
      expect(eaToEm(emToEa(em))).toBeCloseTo(em, 10);
    }
  });

  it("bpsEmToEa(191) matches the typical Bancolombia extract display", () => {
    // 191 bps = 1.91% EM → ~25.49% EA
    expect(bpsEmToEa(191)).toBeCloseTo(0.25488, 4);
  });
});

describe("rates: formatters", () => {
  it("formatBpsEmAsPercent keeps 4 decimals so rates like 1.8311% stay lossless", () => {
    expect(formatBpsEmAsPercent(1831)).toBe("18.3100%");
    expect(formatBpsEmAsPercent(191)).toBe("1.9100%");
  });

  it("formatBpsEmAsEaPercent prints the EA equivalent for display", () => {
    // 191 bps = 1.91% EM → 25.49% EA rounded to 2 decimals
    expect(formatBpsEmAsEaPercent(191)).toBe("25.49%");
    expect(formatBpsEmAsEaPercent(0)).toBe("0.00%");
  });
});

describe("rates: parsePercentToBps", () => {
  it("parses plain decimal", () => {
    expect(parsePercentToBps("1.9110")).toBe(191);
    expect(parsePercentToBps("0")).toBe(0);
    expect(parsePercentToBps("25.5")).toBe(2550);
  });

  it("accepts comma as decimal separator and strips the % suffix", () => {
    expect(parsePercentToBps("1,9110%")).toBe(191);
    expect(parsePercentToBps("1,91")).toBe(191);
  });

  it("rejects negative, NaN, and empty", () => {
    expect(parsePercentToBps("-1")).toBeNull();
    expect(parsePercentToBps("abc")).toBeNull();
    expect(parsePercentToBps("   ")).toBeNull();
  });
});

describe("rates: validateInstallmentRateBps", () => {
  it("accepts 0 (diferido sin intereses — regla 1 de #345)", () => {
    expect(validateInstallmentRateBps(0)).toEqual({ ok: true });
  });

  it("accepts typical TC rates", () => {
    // 191 bps = 1.91% EM — the classic 2-36 cuota Bancolombia rate.
    expect(validateInstallmentRateBps(191)).toEqual({ ok: true });
    // Avance/mora at some banks ~2-3% EM.
    expect(validateInstallmentRateBps(250)).toEqual({ ok: true });
    expect(validateInstallmentRateBps(MIN_NON_ZERO_EM_BPS)).toEqual({ ok: true });
  });

  it("rejects non-zero values < MIN_NON_ZERO_EM_BPS (likely EA mislabeled as EM)", () => {
    // 0.25% EM would give ~3% EA — nonsensical for TC Colombia; more likely
    // the user typed 0.25 thinking of EA.
    expect(validateInstallmentRateBps(25)).toEqual({ ok: false, reason: "too-low" });
  });

  it("rejects negative", () => {
    expect(validateInstallmentRateBps(-100)).toEqual({ ok: false, reason: "negative" });
  });

  it("rejects ≥ 100% EM (almost certainly a typo)", () => {
    expect(validateInstallmentRateBps(MAX_EM_BPS)).toEqual({ ok: false, reason: "too-high" });
    expect(validateInstallmentRateBps(99999)).toEqual({ ok: false, reason: "too-high" });
  });

  it("rejects non-integers", () => {
    expect(validateInstallmentRateBps(1.5)).toEqual({ ok: false, reason: "not-integer" });
  });

  it("messages mention EM vs EA explicitly for too-low (most common mistake)", () => {
    const msg = rateValidationMessage("too-low");
    expect(msg).toMatch(/EM/);
    expect(msg).toMatch(/EA/);
  });
});

describe("rates: resolveBucketRateBps", () => {
  const buckets = { oneMonth: 0, months2to36: 191, advances: 191 };

  it("returns oneMonth bucket when installments = 1", () => {
    expect(resolveBucketRateBps(buckets, 1)).toBe(0);
  });

  it("returns months2to36 bucket for [2, 36]", () => {
    expect(resolveBucketRateBps(buckets, 2)).toBe(191);
    expect(resolveBucketRateBps(buckets, 12)).toBe(191);
    expect(resolveBucketRateBps(buckets, 36)).toBe(191);
  });

  it("returns months2to36 bucket for > 36 installments (no distinct bucket in the extract)", () => {
    expect(resolveBucketRateBps(buckets, 60)).toBe(191);
  });

  it("returns the advances bucket when isAdvance=true regardless of installments", () => {
    expect(resolveBucketRateBps(buckets, 1, true)).toBe(191);
  });

  it("returns null when buckets are undefined / missing the relevant bucket", () => {
    expect(resolveBucketRateBps(undefined, 12)).toBeNull();
    expect(resolveBucketRateBps({ months2to36: 191 }, 1)).toBeNull();
  });
});
