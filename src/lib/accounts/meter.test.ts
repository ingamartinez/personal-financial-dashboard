import { describe, expect, it } from "vitest";
import { computeUsedPct, isHeavyUsage } from "./meter";

describe("computeUsedPct", () => {
  it("returns 80 when 800 of 1000 is used", () => {
    expect(computeUsedPct(BigInt(1000), BigInt(200))).toBe(80);
  });

  it("returns 0 when nothing is used (avail equals limit)", () => {
    expect(computeUsedPct(BigInt(1000), BigInt(1000))).toBe(0);
  });

  it("returns 100 when fully used (avail is 0)", () => {
    expect(computeUsedPct(BigInt(1000), BigInt(0))).toBe(100);
  });

  it("clamps to 0 on overpayment (avail > limit)", () => {
    expect(computeUsedPct(BigInt(1000), BigInt(1100))).toBe(0);
  });

  it("returns 0 when limitCents is null", () => {
    expect(computeUsedPct(null, BigInt(500))).toBe(0);
  });

  it("returns 0 when availableCents is null", () => {
    expect(computeUsedPct(BigInt(1000), null)).toBe(0);
  });

  it("returns 0 when limitCents is zero", () => {
    expect(computeUsedPct(BigInt(0), BigInt(0))).toBe(0);
  });
});

describe("isHeavyUsage", () => {
  it("returns true at exactly 80", () => {
    expect(isHeavyUsage(80)).toBe(true);
  });

  it("returns false at 79", () => {
    expect(isHeavyUsage(79)).toBe(false);
  });

  it("returns true at 100", () => {
    expect(isHeavyUsage(100)).toBe(true);
  });
});
