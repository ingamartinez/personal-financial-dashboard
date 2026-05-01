import { describe, expect, it } from "vitest";
import { detectPriceHike } from "./price-hike-detector";

// Helper: build a minimal observation array (most recent first).
function obs(
  amounts: bigint[],
  currency: "COP" | "USD" = "COP",
): { realAmountCents: bigint; observedAt: Date; realCurrency: "COP" | "USD" }[] {
  // Give each a distinct date, most recent = index 0 = latest date.
  const base = new Date("2026-03-01T00:00:00Z").getTime();
  return amounts.map((realAmountCents, i) => ({
    realAmountCents,
    observedAt: new Date(base - i * 24 * 60 * 60 * 1000),
    realCurrency: currency,
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
    expect(result!.currency).toBe("COP");
  });

  it("detects a qualifying hike for a USD subscription and carries currency through", () => {
    // USD enterprise subscription: prior 3 at $10,000 (1_000_000 cents),
    // latest at $12,000 (1_200_000 cents). Delta = 200,000 cents ≥ 100,000 threshold.
    // deltaPct = 20% ≥ 15% threshold. Both guards pass.
    const observations = obs(
      [BigInt(-1_200_000), BigInt(-1_000_000), BigInt(-1_000_000), BigInt(-1_000_000)],
      "USD",
    );
    const result = detectPriceHike(1, observations);
    expect(result).not.toBeNull();
    expect(result!.currency).toBe("USD");
    expect(result!.oldAmountCents).toBe(BigInt(-1_000_000));
    expect(result!.newAmountCents).toBe(BigInt(-1_200_000));
    expect(result!.deltaPct).toBeCloseTo(20, 1);
  });

  it("returns null for a decrease (new < old in expense sign means smaller charge)", () => {
    // Prior median: -2_800_000. Latest: -2_200_000 (less charge = "cheaper").
    // The detector works on absolute magnitudes:
    //   absOld = 2_800_000, absNew = 2_200_000
    //   absNew (2_200_000) <= absOld (2_800_000) → returns null at the magnitude guard.
    const observations = obs([
      BigInt(-2_200_000),
      BigInt(-2_800_000),
      BigInt(-2_800_000),
      BigInt(-2_800_000),
    ]);
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
