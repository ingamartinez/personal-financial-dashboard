import type { Currency } from "@/lib/types";

const STATEMENT_DRIFT_THRESHOLD_CENTS = { COP: BigInt(500_000_00), USD: BigInt(125_00) } as const;

export function isSignificantBalanceDrift(currency: Currency, driftCents: bigint | null): boolean {
  if (driftCents === null) return false;
  const absolute = driftCents < BigInt(0) ? -driftCents : driftCents;
  return absolute >= STATEMENT_DRIFT_THRESHOLD_CENTS[currency];
}
