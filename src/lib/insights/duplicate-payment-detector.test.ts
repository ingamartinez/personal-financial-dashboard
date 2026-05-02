import { describe, expect, it } from "vitest";
import { withinFivePercent, DUPLICATE_PAYMENT_WINDOW_DAYS } from "./duplicate-payment-detector";

// ---------------------------------------------------------------------------
// Tests — withinFivePercent (pure BigInt tolerance check)
// ---------------------------------------------------------------------------

describe("withinFivePercent — basic tolerance", () => {
  it("returns true for identical amounts", () => {
    expect(withinFivePercent(BigInt(100_000), BigInt(100_000))).toBe(true);
  });

  it("returns true when diff is exactly 5%", () => {
    // 100_000 vs 95_000 → diff=5000, larger=100_000, 5000*20=100_000 == 100_000 → true
    expect(withinFivePercent(BigInt(100_000), BigInt(95_000))).toBe(true);
  });

  it("returns false when diff is more than 5%", () => {
    // 100_000 vs 94_999 → diff=5001, larger=100_000, 5001*20=100_020 > 100_000 → false
    expect(withinFivePercent(BigInt(100_000), BigInt(94_999))).toBe(false);
  });

  it("returns true when amounts are within 5% on the other side", () => {
    // 100_000 vs 105_000 → diff=5000, larger=105_000, 5000*20=100_000 < 105_000 → true
    expect(withinFivePercent(BigInt(100_000), BigInt(105_000))).toBe(true);
  });

  it("returns false when amounts differ by more than 5.26%", () => {
    // The formula diff*20 <= larger is equivalent to diff <= larger/20 = 5% of larger.
    // For base=1_000_000 vs over=X: diff = X - 1_000_000, larger = X.
    // False when: (X - 1_000_000)*20 > X → 20X - 20_000_000 > X → 19X > 20_000_000
    // → X > 1_052_631.  So 1_060_000 is clearly outside.
    const base = BigInt(1_000_000);
    const over = BigInt(1_060_000); // ~5.66% → outside 5%
    expect(withinFivePercent(base, over)).toBe(false);
  });

  it("handles large COP amounts (BigInt-only math)", () => {
    // 500_000_00 COP (~5M) and 499_000_00 COP — diff 1_000_00 / 500_000_00 = 0.2% → true
    expect(withinFivePercent(BigInt(500_000_00), BigInt(499_000_00))).toBe(true);
  });

  it("returns false for zero inputs", () => {
    expect(withinFivePercent(BigInt(0), BigInt(100_000))).toBe(false);
    expect(withinFivePercent(BigInt(100_000), BigInt(0))).toBe(false);
    expect(withinFivePercent(BigInt(0), BigInt(0))).toBe(false);
  });

  it("is commutative — order of arguments doesn't matter", () => {
    const a = BigInt(200_000);
    const b = BigInt(195_000);
    expect(withinFivePercent(a, b)).toBe(withinFivePercent(b, a));
  });
});

describe("withinFivePercent — real-world COP amounts", () => {
  it("matches two subscription charges of the same plan (same amount)", () => {
    // Netflix COP 21,900 on two cards
    const netflix = BigInt(21_900_00);
    expect(withinFivePercent(netflix, netflix)).toBe(true);
  });

  it("matches Netflix with 3% price increase (within 5%)", () => {
    const old = BigInt(21_900_00);
    const newPrice = BigInt(22_557_00); // ~3% increase
    expect(withinFivePercent(old, newPrice)).toBe(true);
  });

  it("does NOT match completely different amounts", () => {
    // Netflix vs Amazon Prime — different prices
    const netflix = BigInt(21_900_00);
    const amazon = BigInt(8_900_00);
    expect(withinFivePercent(netflix, amazon)).toBe(false);
  });
});

describe("DUPLICATE_PAYMENT_WINDOW_DAYS constant", () => {
  it("is 35 days per spec", () => {
    expect(DUPLICATE_PAYMENT_WINDOW_DAYS).toBe(35);
  });
});
