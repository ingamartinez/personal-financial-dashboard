export const HEAVY_USAGE_THRESHOLD = 80;

/**
 * Computes the percentage of a credit limit that is used.
 * Returns 0 when limitCents is null, zero, or negative (no meter applicable).
 * Clamps to [0, 100].
 */
export function computeUsedPct(limitCents: bigint | null, availableCents: bigint | null): number {
  if (limitCents === null || availableCents === null || limitCents <= BigInt(0)) return 0;
  const used = limitCents > availableCents ? limitCents - availableCents : BigInt(0);
  return Math.min(100, Math.max(0, Number((used * BigInt(10000)) / limitCents) / 100));
}

export function isHeavyUsage(pct: number): boolean {
  return pct >= HEAVY_USAGE_THRESHOLD;
}
