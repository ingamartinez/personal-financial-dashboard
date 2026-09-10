// #871 C: Pure amount-outlier detector for VARIABLE recurring transactions.
//
// Sibling of detectPriceHike (#701). That detector is for FIXED recurrings and
// uses a flat 15% + absolute floor — the wrong instrument here. A variable
// bill like EPM oscillates ~±13% around its centre; a flat 5% fires every
// month and a flat 30% never fires for EPM while still missing a real 7%
// Netflix hike. One knob cannot do both jobs.
//
// Threshold is relative to each recurring's own dispersion:
//   1. Need at least 4 observations (1 current + 3 prior), matching detectPriceHike.
//   2. Latest must sit outside the [min, max] band of the prior observations.
//   3. Distance from the prior mean must be ≥ 2 sample standard deviations.
//      When prior variance is 0 (a flat bill), any move ≥ 1% of the mean
//      qualifies — that is the Netflix-hike-on-a-stable-variable case.
//
// All arithmetic uses BigInt. Never coerce money to Number.
// Caller pre-filters variable-type recurrings and excluded observations.
// This function has no DB access and no amountType knowledge.

import type { Currency } from "@/lib/types";

export const MIN_OBSERVATIONS_FOR_OUTLIER = 4;

export interface AmountOutlierObservation {
  id: number;
  realAmountCents: bigint;
  observedAt: Date;
  realCurrency: Currency;
}

export interface AmountOutlier {
  recurringId: number;
  observationId: number;
  outlierAmountCents: bigint;
  /** Signed observation at the smaller-magnitude band edge. Not a numeric min. */
  bandLoAbsCents: bigint;
  /** Signed observation at the larger-magnitude band edge. Not a numeric max. */
  bandHiAbsCents: bigint;
  currency: Currency;
  observationCount: number;
}

function absBigInt(value: bigint): bigint {
  return value < BigInt(0) ? -value : value;
}

/**
 * Detect an amount outlier from observations ordered MOST RECENT FIRST.
 *
 * @returns AmountOutlier when the latest observation is outside the prior
 *          band and ≥ 2σ from the prior mean (or ≥ 1% of mean when σ = 0).
 *          null otherwise.
 */
export function detectAmountOutlier(
  recurringId: number,
  observations: AmountOutlierObservation[],
): AmountOutlier | null {
  if (observations.length < MIN_OBSERVATIONS_FOR_OUTLIER) return null;

  const latest = observations[0]!;
  const prior = observations.slice(1);
  const latestAbs = absBigInt(latest.realAmountCents);

  // Abs for the threshold; keep the signed observations that produced each
  // edge so the returned band matches outlierAmountCents (price-hike-detector
  // uses abs only internally and returns signed amounts).
  let bandMinAbs = absBigInt(prior[0]!.realAmountCents);
  let bandMaxAbs = bandMinAbs;
  let bandMinSigned = prior[0]!.realAmountCents;
  let bandMaxSigned = bandMinSigned;
  for (const o of prior) {
    const value = absBigInt(o.realAmountCents);
    if (value < bandMinAbs) {
      bandMinAbs = value;
      bandMinSigned = o.realAmountCents;
    }
    if (value > bandMaxAbs) {
      bandMaxAbs = value;
      bandMaxSigned = o.realAmountCents;
    }
  }

  // Inside the historical band → a normal swing, not an outlier.
  if (latestAbs >= bandMinAbs && latestAbs <= bandMaxAbs) return null;

  const n = BigInt(prior.length);
  if (n < BigInt(2)) return null;

  let sumX = BigInt(0);
  let sumX2 = BigInt(0);
  for (const o of prior) {
    const value = absBigInt(o.realAmountCents);
    sumX += value;
    sumX2 += value * value;
  }

  // n * sum(x^2) - sum(x)^2 is the numerator of n^2 * population variance.
  // Zero means every prior observation has the same magnitude.
  const sumSq = n * sumX2 - sumX * sumX;

  if (sumSq === BigInt(0)) {
    // Degenerate band. Require ≥ 1% of the mean so a 1-peso blip is not an
    // outlier but a 7% Netflix-style hike is: beyond * 100 * n >= sumX.
    const beyond = latestAbs > bandMaxAbs ? latestAbs - bandMaxAbs : bandMinAbs - latestAbs;
    if (beyond * BigInt(100) * n < sumX) return null;
  } else {
    // |x - mean| >= 2σ, integer form that never divides money:
    // (n*x - sumX)^2 * (n-1) >= 4 * n * (n*sumX2 - sumX^2)
    const nXminusSum = n * latestAbs - sumX;
    const left = nXminusSum * nXminusSum * (n - BigInt(1));
    const right = BigInt(4) * n * sumSq;
    if (left < right) return null;
  }

  return {
    recurringId,
    observationId: latest.id,
    outlierAmountCents: latest.realAmountCents,
    bandLoAbsCents: bandMinSigned,
    bandHiAbsCents: bandMaxSigned,
    currency: latest.realCurrency,
    observationCount: observations.length,
  };
}
