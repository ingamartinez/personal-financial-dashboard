import { describe, expect, it } from "vitest";
import { detectPriceHike } from "./price-hike-detector";

// Helper: build a minimal observation array (most recent first).
function obs(amounts: bigint[]): { realAmountCents: bigint; observedAt: Date }[] {
  // Give each a distinct date, most recent = index 0 = latest date.
  const base = new Date("2026-03-01T00:00:00Z").getTime();
  return amounts.map((realAmountCents, i) => ({
    realAmountCents,
    observedAt: new Date(base - i * 24 * 60 * 60 * 1000),
  }));
}

describe("detectPriceHike", () => {
  it("returns null when stable (no hike)", () => {
    // 4 observations all at the same amount — no hike.
    const observations = obs([
      BigInt(-2_200_000),
      BigInt(-2_200_000),
      BigInt(-2_200_000),
      BigInt(-2_200_000),
    ]);
    expect(detectPriceHike(1, observations)).toBeNull();
  });

  it("detects a qualifying hike (≥15%, ≥1000 COP)", () => {
    // Prior 3: -2_200_000, -2_200_000, -2_200_000 → median = -2_200_000 (abs 2_200_000)
    // Latest: -2_800_000 (abs 2_800_000)
    // deltaPct = (600_000 * 100) / 2_200_000 ≈ 27.27%
    const observations = obs([
      BigInt(-2_800_000),
      BigInt(-2_200_000),
      BigInt(-2_200_000),
      BigInt(-2_200_000),
    ]);
    const result = detectPriceHike(1, observations);
    expect(result).not.toBeNull();
    expect(result!.recurringId).toBe(1);
    expect(result!.oldAmountCents).toBe(BigInt(-2_200_000));
    expect(result!.newAmountCents).toBe(BigInt(-2_800_000));
    expect(result!.deltaPct).toBeCloseTo(27.27, 1);
    expect(result!.sinceDate).toEqual(observations[0]!.observedAt);
  });

  it("returns null for a decrease (new < old in expense sign means smaller charge)", () => {
    // Prior median: -2_800_000. Latest: -2_200_000 (less charge = "cheaper").
    // newAmountCents (-2_200_000) > oldAmountCents (-2_800_000) in signed comparison:
    // -2_200_000 > -2_800_000 is TRUE, so the signed-value increase path would trigger.
    // But in terms of expense magnitude: abs(-2_200_000)=2_200_000 < abs(-2_800_000)=2_800_000
    // → absDelta would be negative → absDelta < 100_000n → returns null.
    const observations = obs([
      BigInt(-2_200_000),
      BigInt(-2_800_000),
      BigInt(-2_800_000),
      BigInt(-2_800_000),
    ]);
    // Here newAmountCents(-2_200_000) > oldAmountCents(-2_800_000) signed → passes first guard.
    // But absNew(2_200_000) - absOld(2_800_000) = -600_000 < 100_000n → null.
    const result = detectPriceHike(1, observations);
    expect(result).toBeNull();
  });

  it("returns null for insufficient history (< 4 observations)", () => {
    const observations = obs([BigInt(-2_800_000), BigInt(-2_200_000), BigInt(-2_200_000)]);
    expect(detectPriceHike(1, observations)).toBeNull();
  });

  it("returns null when delta is below 15% threshold", () => {
    // Prior 3: -2_200_000. Latest: -2_300_000.
    // deltaPct ≈ 4.5% — below 15%.
    const observations = obs([
      BigInt(-2_300_000),
      BigInt(-2_200_000),
      BigInt(-2_200_000),
      BigInt(-2_200_000),
    ]);
    expect(detectPriceHike(1, observations)).toBeNull();
  });

  it("returns null when absolute delta is below 100_000 cents (1000 COP)", () => {
    // Prior 3: -500_000. Latest: -600_000.
    // deltaPct = 20% (qualifies), but absOld + absDelta must push past 100_000n.
    // abs delta = 100_000 — exactly on the boundary: 100_000 < 100_000 is false,
    // so test with 99_999 cents delta to verify the < guard.
    // Prior: -500_000. Latest: -599_999. absDelta = 99_999 < 100_000 → null.
    const observations = obs([
      BigInt(-599_999),
      BigInt(-500_000),
      BigInt(-500_000),
      BigInt(-500_000),
    ]);
    // deltaPct ≈ 20% but absDelta 99_999 < 100_000 → null.
    expect(detectPriceHike(1, observations)).toBeNull();
  });

  it("uses median of prior 3 (not mean or first/last)", () => {
    // Prior 3: -2_000_000, -2_200_000, -3_000_000 → sorted ascending: [-3_000_000, -2_200_000, -2_000_000]
    // Wait — BigInt sort ascending: -3_000_000 < -2_200_000 < -2_000_000.
    // median = -2_200_000 (abs 2_200_000).
    // Latest: -2_800_000 (abs 2_800_000). delta = 600_000. pct ≈ 27.27% → hike.
    const observations = obs([
      BigInt(-2_800_000),
      BigInt(-2_000_000),
      BigInt(-2_200_000),
      BigInt(-3_000_000),
    ]);
    const result = detectPriceHike(1, observations);
    expect(result).not.toBeNull();
    // Median of prior 3 (ascending sort: -3_000_000, -2_200_000, -2_000_000) → -2_200_000.
    expect(result!.oldAmountCents).toBe(BigInt(-2_200_000));
  });
});
