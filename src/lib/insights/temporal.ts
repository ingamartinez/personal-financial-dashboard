/**
 * Temporal spend pattern detection — E.1 daily heatmap + E.2 expensive days
 * + E.3 seasonality. Part of Epic I (#255), issue #717.
 *
 * E.1 — Daily heatmap:
 *   Last 365 days from today, GitHub-contributions style grid (7 rows × ~53
 *   cols). Bins: none (0), light (≤p25 of non-zero days), medium (≤p75),
 *   high (>p75). Multi-currency amounts converted to COP via toCop.
 *
 * E.2 — Expensive days:
 *   For each day-of-week, average spend over last 90 days. Triggers when DOW
 *   avg ≥ 1.4× cross-DOW mean AND ≥ COP 50,000 (5_000_000 cents) floor.
 *   Returns top 2, sorted by deltaPct desc.
 *
 * E.3 — Seasonality:
 *   Per calendar month, average monthly spend over last 24 months. Triggers
 *   when monthAvg ≥ 1.3× annual mean. Sparse-data guard: months with <50% of
 *   expected tx count excluded. Hidden entirely if <12 months of history.
 *
 * All pure functions — no DB, no side-effects.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type SpendBin = "none" | "light" | "medium" | "high";

export type DayBucket = {
  /** ISO date string "YYYY-MM-DD" */
  date: string;
  bin: SpendBin;
  /** COP cents as bigint */
  copCents: bigint;
};

/** Serializable variant for RSC → client boundary (BigInt → string). */
export type DayBucketSerialized = {
  date: string;
  bin: SpendBin;
  /** COP cents serialized as string (BigInt transport) */
  copCents: string;
};

export type PerDayTotal = {
  day: Date;
  cop: bigint;
};

export type ExpensiveDayResult = {
  dow: number; // 0=Sunday..6=Saturday
  dowAvgCop: bigint;
  deltaPct: number;
};

export type SeasonalityResult = {
  monthIndex: number; // 1..12
  monthAvgCop: bigint;
  deltaPct: number;
};

// ---------------------------------------------------------------------------
// Date helpers — native Date.UTC, no date-fns
// ---------------------------------------------------------------------------

/**
 * Format a UTC date as "YYYY-MM-DD".
 */
export function toDateStr(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dy = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dy}`;
}

/**
 * Floor a Date to the start of its UTC day (midnight UTC).
 */
function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ---------------------------------------------------------------------------
// E.1 — Heatmap
// ---------------------------------------------------------------------------

/**
 * Compute percentile thresholds from a sorted array of positive bigint values.
 * Returns { p25, p75 }. Returns { p25: 0n, p75: 0n } for empty input.
 */
export function computePercentiles(sorted: bigint[]): { p25: bigint; p75: bigint } {
  if (sorted.length === 0) return { p25: BigInt(0), p75: BigInt(0) };

  const p25Idx = Math.floor(sorted.length * 0.25);
  const p75Idx = Math.floor(sorted.length * 0.75);

  return {
    p25: sorted[Math.min(p25Idx, sorted.length - 1)]!,
    p75: sorted[Math.min(p75Idx, sorted.length - 1)]!,
  };
}

/**
 * Classify a single day's COP total into a bin.
 */
export function classifyBin(copCents: bigint, p25: bigint, p75: bigint): SpendBin {
  if (copCents === BigInt(0)) return "none";
  if (copCents <= p25) return "light";
  if (copCents <= p75) return "medium";
  return "high";
}

/**
 * Compute the daily heatmap for the last 365 days from `today`.
 *
 * @param today      Reference date (today).
 * @param perDay     Array of per-day COP totals already converted to COP cents.
 *                   Days missing from the array are treated as 0.
 *                   Days outside [today-365d, today) are ignored.
 */
export function computeDailyHeatmap(today: Date, perDay: PerDayTotal[]): DayBucket[] {
  const todayMs = utcDayStart(today).getTime();
  const startMs = todayMs - 365 * 86400000; // inclusive lower bound: oldest day in grid

  // Build a lookup map: dateStr → copCents
  const lookup = new Map<string, bigint>();
  for (const entry of perDay) {
    const dayMs = utcDayStart(entry.day).getTime();
    if (dayMs < startMs || dayMs >= todayMs) continue;
    const key = toDateStr(new Date(dayMs));
    const existing = lookup.get(key) ?? BigInt(0);
    lookup.set(key, existing + entry.cop);
  }

  // Collect all non-zero values for percentile computation
  const nonZeroValues: bigint[] = [];
  for (const v of lookup.values()) {
    if (v > BigInt(0)) nonZeroValues.push(v);
  }
  nonZeroValues.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const { p25, p75 } = computePercentiles(nonZeroValues);

  // Generate all 365 days oldest→newest: from (today - 365d) to yesterday.
  // offset=365 → today-365d (oldest), offset=1 → yesterday (newest).
  // today (offset=0) is excluded — the heatmap shows completed days only.
  const buckets: DayBucket[] = [];
  for (let offset = 365; offset >= 1; offset--) {
    const dayMs = todayMs - offset * 86400000;
    const date = toDateStr(new Date(dayMs));
    const copCents = lookup.get(date) ?? BigInt(0);
    buckets.push({
      date,
      bin: classifyBin(copCents, p25, p75),
      copCents,
    });
  }

  return buckets;
}

// ---------------------------------------------------------------------------
// E.2 — Expensive days
// ---------------------------------------------------------------------------

const DOW_NAMES_ES = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
] as const;

export function dowNameEs(dow: number): string {
  return DOW_NAMES_ES[dow] ?? "?";
}

/** Floor for triggering expensive-day: COP 50,000 = 5_000_000 cents. */
const EXPENSIVE_DAY_FLOOR_CENTS = BigInt(50_000) * BigInt(100);

/** Multiplier threshold: DOW avg must be ≥ 1.4× cross-DOW mean. */
const EXPENSIVE_DAY_FACTOR = 1.4;

/**
 * Detect expensive days of the week from the last 90 days of per-day totals.
 *
 * @param perDay  Array of per-day totals (any date range — filtering applied here).
 *                Caller should pass ~90 days of data for meaningful signal.
 *                Values already in COP cents.
 * @param today   Reference date.
 *
 * Returns top 2 DOWs that meet both thresholds, sorted by deltaPct desc.
 * Returns empty array if fewer than 30 days of data in the 90-day window.
 */
export function detectExpensiveDays(
  perDay: PerDayTotal[],
  today: Date = new Date(),
): ExpensiveDayResult[] {
  const todayMs = utcDayStart(today).getTime();
  const windowStart = todayMs - 90 * 86400000;

  // Filter to 90-day window
  const window90 = perDay.filter((d) => {
    const ms = utcDayStart(d.day).getTime();
    return ms >= windowStart && ms < todayMs;
  });

  // Insufficient data guard
  const uniqueDays = new Set(window90.map((d) => toDateStr(utcDayStart(d.day)))).size;
  if (uniqueDays < 30) return [];

  // Sum spend by DOW across the window
  const dowTotals: bigint[] = new Array(7).fill(null).map(() => BigInt(0));
  const dowCounts: number[] = new Array(7).fill(0);

  for (const entry of window90) {
    const dow = utcDayStart(entry.day).getUTCDay();
    dowTotals[dow] = (dowTotals[dow] ?? BigInt(0)) + entry.cop;
    dowCounts[dow] = (dowCounts[dow] ?? 0) + 1;
  }

  // Compute per-DOW average. Days with 0 occurrences get avg = 0.
  const dowAvgs: bigint[] = dowTotals.map((total, i) => {
    const count = dowCounts[i] ?? 0;
    return count > 0 ? total / BigInt(count) : BigInt(0);
  });

  // Cross-DOW mean (mean of the 7 DOW averages)
  const sum7 = dowAvgs.reduce((acc, v) => acc + v, BigInt(0));
  const crossDowMean = sum7 / BigInt(7);

  if (crossDowMean === BigInt(0)) return [];

  // Identify triggering DOWs
  const results: ExpensiveDayResult[] = [];
  for (let dow = 0; dow < 7; dow++) {
    const avg = dowAvgs[dow] ?? BigInt(0);
    const thresholdCents = BigInt(Math.round(Number(crossDowMean) * EXPENSIVE_DAY_FACTOR));

    if (avg >= thresholdCents && avg >= EXPENSIVE_DAY_FLOOR_CENTS) {
      const deltaPct = Math.round(
        ((Number(avg) - Number(crossDowMean)) / Number(crossDowMean)) * 100,
      );
      results.push({ dow, dowAvgCop: avg, deltaPct });
    }
  }

  // Sort by deltaPct desc and return top 2
  results.sort((a, b) => b.deltaPct - a.deltaPct);
  return results.slice(0, 2);
}

// ---------------------------------------------------------------------------
// E.3 — Seasonality
// ---------------------------------------------------------------------------

const MONTH_NAMES_ES = [
  "",
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

export function monthNameEs(monthIndex: number): string {
  return MONTH_NAMES_ES[monthIndex] ?? "?";
}

/** Seasonality trigger: monthAvg ≥ 1.3× annual mean. */
const SEASONALITY_FACTOR = 1.3;

/**
 * Detect high-spend calendar months from up to 24 months of per-day totals.
 *
 * @param perDay  Array of per-day totals (any date range). Already in COP cents.
 * @param today   Reference date.
 *
 * Returns empty array if fewer than 12 months of history exist.
 * Returns top 3 months sorted by deltaPct desc.
 */
export function detectSeasonality(
  perDay: PerDayTotal[],
  today: Date = new Date(),
): SeasonalityResult[] {
  const todayMs = utcDayStart(today).getTime();
  const windowStart = todayMs - 730 * 86400000; // 24 months ≈ 730 days

  // Filter to 730-day window
  const window730 = perDay.filter((d) => {
    const ms = utcDayStart(d.day).getTime();
    return ms >= windowStart && ms < todayMs;
  });

  if (window730.length === 0) return [];

  // Determine distinct calendar months present in the dataset
  const monthKeySet = new Set<string>();
  for (const entry of window730) {
    const d = utcDayStart(entry.day);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`;
    monthKeySet.add(key);
  }

  const distinctMonthCount = monthKeySet.size;
  if (distinctMonthCount < 12) return [];

  // Group daily spend into (year, monthIndex 1..12) buckets
  // monthBuckets: Map<monthIndex, Map<"YYYY-M", totalCents>>
  const monthBuckets = new Map<number, Map<string, bigint>>();
  // txCountByMonthKey: Map<"YYYY-M", number>
  const txCountByMonthKey = new Map<string, number>();

  for (const entry of window730) {
    const d = utcDayStart(entry.day);
    const monthIdx = d.getUTCMonth() + 1; // 1..12
    const ymKey = `${d.getUTCFullYear()}-${monthIdx}`;

    if (!monthBuckets.has(monthIdx)) {
      monthBuckets.set(monthIdx, new Map());
    }
    const byYear = monthBuckets.get(monthIdx)!;
    byYear.set(ymKey, (byYear.get(ymKey) ?? BigInt(0)) + entry.cop);

    txCountByMonthKey.set(ymKey, (txCountByMonthKey.get(ymKey) ?? 0) + 1);
  }

  // Compute the overall average tx count per month-year bucket (for sparse-data guard)
  let totalTxCount = 0;
  for (const count of txCountByMonthKey.values()) {
    totalTxCount += count;
  }
  const avgTxPerMonthKey = distinctMonthCount > 0 ? totalTxCount / distinctMonthCount : 0;

  // Compute per-calendar-month averages, filtering sparse month-years
  const monthAvgs = new Map<number, bigint>(); // monthIndex → avgCop

  for (const [monthIdx, byYear] of monthBuckets) {
    const qualifying: bigint[] = [];

    for (const [ymKey, total] of byYear) {
      const txCount = txCountByMonthKey.get(ymKey) ?? 0;
      // Sparse-data guard: skip month-years with <50% of avg tx count
      if (avgTxPerMonthKey > 0 && txCount < avgTxPerMonthKey * 0.5) continue;
      qualifying.push(total);
    }

    if (qualifying.length === 0) continue;

    const sum = qualifying.reduce((acc, v) => acc + v, BigInt(0));
    monthAvgs.set(monthIdx, sum / BigInt(qualifying.length));
  }

  if (monthAvgs.size === 0) return [];

  // Annual mean = mean of the 12 monthly averages
  let sumAvgs = BigInt(0);
  for (const avg of monthAvgs.values()) {
    sumAvgs += avg;
  }
  const annualMean = sumAvgs / BigInt(12);

  if (annualMean === BigInt(0)) return [];

  // Identify triggering months
  const results: SeasonalityResult[] = [];
  for (const [monthIdx, monthAvgCop] of monthAvgs) {
    const thresholdCents = BigInt(Math.round(Number(annualMean) * SEASONALITY_FACTOR));

    if (monthAvgCop >= thresholdCents) {
      const deltaPct = Math.round(
        ((Number(monthAvgCop) - Number(annualMean)) / Number(annualMean)) * 100,
      );
      results.push({ monthIndex: monthIdx, monthAvgCop, deltaPct });
    }
  }

  results.sort((a, b) => b.deltaPct - a.deltaPct);
  return results.slice(0, 3);
}
