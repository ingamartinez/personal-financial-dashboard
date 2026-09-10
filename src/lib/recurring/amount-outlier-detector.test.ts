import { describe, expect, it } from "vitest";
import { detectAmountOutlier, MIN_OBSERVATIONS_FOR_OUTLIER } from "./amount-outlier-detector";
import type { AmountOutlierObservation } from "./amount-outlier-detector";

function obs(amounts: bigint[], currency: "COP" | "USD" = "COP"): AmountOutlierObservation[] {
  const base = new Date("2026-06-01T00:00:00Z").getTime();
  return amounts.map((realAmountCents, i) => ({
    id: 100 - i,
    realAmountCents,
    observedAt: new Date(base - i * 24 * 60 * 60 * 1000),
    realCurrency: currency,
  }));
}

describe("detectAmountOutlier", () => {
  it(`returns null when there are fewer than ${MIN_OBSERVATIONS_FOR_OUTLIER} observations`, () => {
    const observations = obs([BigInt(-80_000), BigInt(-44_900), BigInt(-44_900)]);
    expect(detectAmountOutlier(1, observations)).toBeNull();
  });

  it("does NOT fire on EPM's normal month-to-month swing", () => {
    // Prod range 518.660 – 667.775 COP. A 600.000 month sits inside the band.
    const observations = obs([
      BigInt(-600_000),
      BigInt(-667_775),
      BigInt(-580_000),
      BigInt(-518_660),
    ]);
    expect(detectAmountOutlier(15, observations)).toBeNull();
  });

  it("does NOT fire on a slight new high inside EPM's dispersion", () => {
    // 670.000 is just above the prior max (667.775) but well under 2σ.
    const observations = obs([
      BigInt(-670_000),
      BigInt(-667_775),
      BigInt(-580_000),
      BigInt(-518_660),
    ]);
    expect(detectAmountOutlier(15, observations)).toBeNull();
  });

  it("fires when a spike sits outside the band and beyond 2σ", () => {
    const observations = obs([
      BigInt(-1_200_000),
      BigInt(-667_775),
      BigInt(-580_000),
      BigInt(-518_660),
    ]);
    const result = detectAmountOutlier(15, observations);
    expect(result).not.toBeNull();
    expect(result!.recurringId).toBe(15);
    expect(result!.observationId).toBe(100);
    expect(result!.outlierAmountCents).toBe(BigInt(-1_200_000));
    expect(result!.bandLoAbsCents).toBe(BigInt(-518_660));
    expect(result!.bandHiAbsCents).toBe(BigInt(-667_775));
    expect(result!.currency).toBe("COP");
  });

  it("fires a 7% hike on a previously flat variable bill (σ = 0)", () => {
    // Netflix-style: three identical priors, latest is ~7% higher.
    const observations = obs([BigInt(-44_900), BigInt(-42_000), BigInt(-42_000), BigInt(-42_000)]);
    const result = detectAmountOutlier(1, observations);
    expect(result).not.toBeNull();
    expect(result!.outlierAmountCents).toBe(BigInt(-44_900));
    expect(result!.bandLoAbsCents).toBe(BigInt(-42_000));
    expect(result!.bandHiAbsCents).toBe(BigInt(-42_000));
  });

  it("does NOT fire a 1-peso blip on a flat bill", () => {
    const observations = obs([BigInt(-42_001), BigInt(-42_000), BigInt(-42_000), BigInt(-42_000)]);
    expect(detectAmountOutlier(1, observations)).toBeNull();
  });

  it("returns null when the latest amount is inside the prior min/max", () => {
    const observations = obs([BigInt(-50_000), BigInt(-60_000), BigInt(-40_000), BigInt(-55_000)]);
    expect(detectAmountOutlier(1, observations)).toBeNull();
  });
});
