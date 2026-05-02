import type { SubscriptionRow } from "@/app/(app)/subscriptions/queries";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TierName = "top" | "medianas" | "pequeñas";

export interface TierClassification {
  top: SubscriptionRow[];
  medianas: SubscriptionRow[];
  pequeñas: SubscriptionRow[];
  topSubtotal: bigint;
  medianasSubtotal: bigint;
  pequeñasSubtotal: bigint;
  /** 0–100 percentage for Top tier */
  topPct: number;
  /** 0–100 percentage for Medianas tier */
  medianasPct: number;
  /** 0–100 percentage for Pequeñas tier */
  pequeñasPct: number;
}

// ---------------------------------------------------------------------------
// Pure function
// ---------------------------------------------------------------------------

/**
 * Classify subscription rows into Pareto tiers.
 *
 * Algorithm:
 *   1. ABS the displayAmount.cents for each row (amounts are negative expenses).
 *   2. Sort descending by absolute display cents.
 *   3. Compute grand total.
 *   4. Top: add rows until cumulative ≥ 70% of total. Always at least 1 row.
 *   5. Medianas: continue adding rows until cumulative ≥ 90% of total.
 *   6. Pequeñas: remaining rows.
 *
 * Empty input → three empty tiers with zero subtotals.
 */
export function classifyTiers(rows: SubscriptionRow[]): TierClassification {
  if (rows.length === 0) {
    return {
      top: [],
      medianas: [],
      pequeñas: [],
      topSubtotal: BigInt(0),
      medianasSubtotal: BigInt(0),
      pequeñasSubtotal: BigInt(0),
      topPct: 0,
      medianasPct: 0,
      pequeñasPct: 0,
    };
  }

  // Sort by absolute display cents descending.
  const sorted = [...rows].sort((a, b) => {
    const aAbs = a.displayAmount.cents < BigInt(0) ? -a.displayAmount.cents : a.displayAmount.cents;
    const bAbs = b.displayAmount.cents < BigInt(0) ? -b.displayAmount.cents : b.displayAmount.cents;
    if (bAbs > aAbs) return 1;
    if (bAbs < aAbs) return -1;
    return a.id - b.id;
  });

  // Grand total (all absolute cents).
  const grandTotal = sorted.reduce((acc, row) => {
    const abs =
      row.displayAmount.cents < BigInt(0) ? -row.displayAmount.cents : row.displayAmount.cents;
    return acc + abs;
  }, BigInt(0));

  // Edge: grand total is zero (all rows have zero amount). Put everything in Top.
  if (grandTotal === BigInt(0)) {
    const subtotal = BigInt(0);
    return {
      top: sorted,
      medianas: [],
      pequeñas: [],
      topSubtotal: subtotal,
      medianasSubtotal: BigInt(0),
      pequeñasSubtotal: BigInt(0),
      topPct: 100,
      medianasPct: 0,
      pequeñasPct: 0,
    };
  }

  const top: SubscriptionRow[] = [];
  const medianas: SubscriptionRow[] = [];
  const pequeñas: SubscriptionRow[] = [];

  // Use scaled integer arithmetic to avoid floating-point: compare cumulative*100 vs grandTotal*threshold.
  // threshold70 = grandTotal * 70, threshold90 = grandTotal * 90
  const threshold70 = grandTotal * BigInt(70);
  const threshold90 = grandTotal * BigInt(90);

  let cumulative = BigInt(0);
  // topSatisfied: true once cumulative >= 70% (i.e., we've added enough rows to Top)
  let topSatisfied = false;
  // medianasSatisfied: true once cumulative >= 90%
  let medianasSatisfied = false;

  for (const row of sorted) {
    const abs =
      row.displayAmount.cents < BigInt(0) ? -row.displayAmount.cents : row.displayAmount.cents;
    cumulative += abs;

    const cumulativePct100 = cumulative * BigInt(100);

    if (!topSatisfied) {
      // Keep adding to Top until cumulative >= 70% (or it's the first row — always at least 1).
      top.push(row);
      if (cumulativePct100 >= threshold70) {
        topSatisfied = true;
      }
    } else if (!medianasSatisfied) {
      medianas.push(row);
      if (cumulativePct100 >= threshold90) {
        medianasSatisfied = true;
      }
    } else {
      pequeñas.push(row);
    }
  }

  const sumTier = (tier: SubscriptionRow[]): bigint =>
    tier.reduce((acc, row) => {
      const abs =
        row.displayAmount.cents < BigInt(0) ? -row.displayAmount.cents : row.displayAmount.cents;
      return acc + abs;
    }, BigInt(0));

  const topSubtotal = sumTier(top);
  const medianasSubtotal = sumTier(medianas);
  const pequeñasSubtotal = sumTier(pequeñas);

  // Percentages as numbers (rounded to 1 decimal).
  const grandTotalNum = Number(grandTotal);
  const topPct = Math.round((Number(topSubtotal) / grandTotalNum) * 100);
  const medianasPct = Math.round((Number(medianasSubtotal) / grandTotalNum) * 100);
  const pequeñasPct = 100 - topPct - medianasPct;

  return {
    top,
    medianas,
    pequeñas,
    topSubtotal,
    medianasSubtotal,
    pequeñasSubtotal,
    topPct,
    medianasPct,
    pequeñasPct,
  };
}
