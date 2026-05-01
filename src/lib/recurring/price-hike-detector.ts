// #701: Pure price-hike detector for subscription recurring transactions.
//
// Compares the most recent realAmountCents observation against the median of the
// 3 prior observations. Returns a PriceHike when:
//   - At least 4 observations exist (1 current + 3 prior)
//   - Delta is ≥ 15% increase
//   - Absolute delta is ≥ 100_000 cents (= 1000 COP, since 1 COP = 100 cents)
//
// Variable-type recurrings must be filtered out BY THE CALLER before passing
// observations here. This function has no access to amountType.
//
// All arithmetic uses BigInt — never coerce to Number for money comparisons.

import type { Currency } from "@/lib/types";

export interface PriceHike {
  recurringId: number;
  oldAmountCents: bigint;
  newAmountCents: bigint;
  /** Percentage increase as a plain number (e.g. 27 for +27%). Always positive. */
  deltaPct: number;
  /** The observedAt date of the first observation at the new amount. */
  sinceDate: Date;
  /** Native currency of the subscription (COP or USD). */
  currency: Currency;
}

/**
 * Detect a price hike from an ordered list of observations (most recent first).
 *
 * @param recurringId  The recurring_transaction id — included in the return value.
 * @param observations List of observations ordered MOST RECENT FIRST.
 *                     Each entry must have `realAmountCents` (bigint), `observedAt` (Date),
 *                     and `realCurrency` (Currency). Caller must pre-filter variable-type recurrings.
 * @returns PriceHike when a qualifying increase is detected, null otherwise.
 */
export function detectPriceHike(
  recurringId: number,
  observations: { realAmountCents: bigint; observedAt: Date; realCurrency: Currency }[],
): PriceHike | null {
  // Need at least 4 observations: 1 current + 3 prior.
  if (observations.length < 4) return null;

  // Most recent observation is the candidate "new" amount.
  const latest = observations[0]!;
  const newAmountCents = latest.realAmountCents;

  // Prior 3 observations (indices 1, 2, 3).
  const prior = [
    observations[1]!.realAmountCents,
    observations[2]!.realAmountCents,
    observations[3]!.realAmountCents,
  ];

  // Median of prior 3: sort ascending, take middle (index 1).
  // Use BigInt-safe comparison sort.
  const sorted = [...prior].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const oldAmountCents = sorted[1]!;

  // Work with absolute magnitudes — expenses are stored as negative cents.
  // A "price hike" means the absolute magnitude increased (e.g. -2_200_000 → -2_800_000).
  const absOld = oldAmountCents < BigInt(0) ? -oldAmountCents : oldAmountCents;
  const absNew = newAmountCents < BigInt(0) ? -newAmountCents : newAmountCents;

  // Only detect magnitude increases.
  if (absNew <= absOld) return null;

  const absDelta = absNew - absOld;

  // Absolute threshold: ≥ 100_000 cents (1000 COP).
  if (absDelta < BigInt(100_000)) return null;

  // Percentage threshold: ≥ 15%.
  // deltaPct = (absDelta * 100) / absOld — integer math, then convert to Number for display.
  // Multiply by 10000 for two decimal places of precision before converting to Number.
  if (absOld === BigInt(0)) return null; // guard against division by zero
  const deltaPctX100 = (absDelta * BigInt(10_000)) / absOld;
  const deltaPct = Number(deltaPctX100) / 100;

  if (deltaPct < 15) return null;

  return {
    recurringId,
    oldAmountCents,
    newAmountCents,
    deltaPct,
    sinceDate: latest.observedAt,
    currency: latest.realCurrency,
  };
}
