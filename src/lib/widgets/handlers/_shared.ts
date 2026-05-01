/**
 * Helpers shared by widget handlers that speak the v1 Scriptable/Tasker
 * contract. Keep this module tiny — anything with a clear home in
 * `@/lib/accounts` or `@/lib/money` belongs there, not here. The only reason
 * these live under `widgets/` is that every widget response negotiates the
 * same three things:
 *
 * - `generated_at` as a Bogota-offset ISO string (Colombia has no DST so
 *   UTC-5 is exact year-round),
 * - COP cents → integer pesos conversion (widgets never show cents),
 * - `utilization_pct` rounded to an integer percentage.
 *
 * Other handlers (tc-focus, mis-tcs, …) import from here to stay byte-for-byte
 * consistent on these small primitives.
 *
 * `nowInBogota` and `BogotaYmd` are also exported here so the TC health-check
 * worker and insights page card can import the canonical Bogota-clock logic
 * without pulling in the widget layer.
 */

const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;

/**
 * A calendar date decomposed into year, month (1..12), and day-of-month in
 * the America/Bogota timezone (UTC-5, no DST).
 */
export type BogotaYmd = { year: number; month: number; day: number };

/**
 * Decompose `now` into a Bogota-local calendar date. Colombia observes a fixed
 * UTC-5 offset year-round (no DST), so we shift by 5 h and read the UTC
 * components of the shifted date.
 */
export function nowInBogota(now: Date): BogotaYmd {
  const shifted = new Date(now.getTime() - BOGOTA_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1, // 1..12
    day: shifted.getUTCDate(),
  };
}

/**
 * Formats `now` as an ISO-8601 string in Bogota local time with the `-05:00`
 * offset suffix, seconds precision, no millis — matches the sample response
 * in issue #386 and #385 exactly. We format the shifted UTC components by
 * hand to avoid Date.toLocaleString's non-ISO output.
 */
export function bogotaIsoNow(now: Date): string {
  const shifted = new Date(now.getTime() - BOGOTA_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  const ss = String(shifted.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}-05:00`;
}

const BI_ZERO = BigInt(0);
const BI_HUNDRED = BigInt(100);
const BI_TEN_THOUSAND = BigInt(10000);

/**
 * Integer-pesos narrowing: COP amounts we surface (cupo, balances) fit
 * comfortably under Number.MAX_SAFE_INTEGER after dividing by 100, so it is
 * safe to coerce. Drops anything below the peso — the widget UX has no room
 * for cents.
 */
export function centsToCop(cents: bigint): number {
  return Number(cents / BI_HUNDRED);
}

/**
 * Rounds `(used / limit) * 100` to the nearest integer percent. Returns 0
 * when `limit` is zero or negative — a cupo of 0 is not a divide-by-zero, it
 * is an un-utilized card with no headroom to measure.
 */
export function roundUtilizationPct(used: bigint, limit: bigint): number {
  if (limit <= BI_ZERO) return 0;
  const scaled = (used * BI_TEN_THOUSAND) / limit;
  return Math.round(Number(scaled) / 100);
}
