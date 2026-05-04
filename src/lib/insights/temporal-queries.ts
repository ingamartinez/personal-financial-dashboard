/**
 * Temporal spend pattern queries for the /insights page card.
 *
 * Server-side only — no BullMQ / ioredis transitively pulled in.
 * Called in real-time by the /insights RSC.
 *
 * Fetches up to 730 days of per-day expense totals (in native currency),
 * converts to COP, and feeds the pure detection functions in temporal.ts.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { notDeleted, notInternalMovement } from "@/lib/db/helpers";
import { toCop } from "@/lib/money";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "insights/temporal-queries" });
import {
  computeDailyHeatmap,
  detectExpensiveDays,
  detectSeasonality,
  type DayBucketSerialized,
  type ExpensiveDayResult,
  type PerDayTotal,
  type SeasonalityResult,
} from "./temporal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TemporalSummary = {
  /** 365-day heatmap buckets (oldest→newest), BigInt copCents serialized. */
  dayBuckets: DayBucketSerialized[];
  /** Top-2 expensive day-of-week results (may be empty). */
  expensiveDays: ExpensiveDayResult[];
  /** Top-3 high-spend months (may be empty; empty = <12 months of history). */
  seasonality: SeasonalityResult[];
  /** True when user has no expense data in the last 365 days. */
  hasNoData: boolean;
};

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Fetch per-day expense totals and compute all three temporal insights.
 *
 * Queries the last 730 days of non-transfer, non-deleted expenses grouped by
 * (day, currency). Converts each day's total to COP using the current FX rate.
 *
 * @param userId  Authenticated user id.
 * @param today   Reference date (defaults to now). Injected for testability.
 */
export async function fetchTemporalSummary(
  userId: number,
  today: Date = new Date(),
): Promise<TemporalSummary> {
  const fx = await getCurrentFxRate();
  const copPerUsd = fx.rate;

  // 730 days back from today
  const windowStart = new Date(today.getTime() - 730 * 86400000);

  // Aggregate per-day expense totals by (date, currency).
  // We aggregate natively then convert to COP in JS to avoid SQL float drift.
  // Using Drizzle builder for all columns; no raw Date/BigInt in template params.
  let rows: { dayStr: string; currency: string; totalCents: string }[];
  try {
    rows = await db
      .select({
        dayStr: sql<string>`TO_CHAR(${transactions.occurredAt} AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD')`,
        currency: transactions.currency,
        totalCents: sql<string>`SUM(ABS(${transactions.amountCents}))::text`,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          notDeleted(transactions.deletedAt),
          notInternalMovement(transactions.channel),
          // Only expenses (negative amounts)
          sql`${transactions.amountCents} < 0`,
          gte(transactions.occurredAt, windowStart),
        ),
      )
      .groupBy(
        sql`TO_CHAR(${transactions.occurredAt} AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD')`,
        transactions.currency,
      );
  } catch (err) {
    log.error({ err, userId, event: "temporal_query_failed" }, "temporal query failed");
    throw err;
  }

  if (rows.length === 0) {
    // No expenses at all — return empty heatmap with hasNoData flag
    const buckets = computeDailyHeatmap(today, []);
    return {
      dayBuckets: buckets.map((b) => ({ ...b, copCents: b.copCents.toString() })),
      expensiveDays: [],
      seasonality: [],
      hasNoData: true,
    };
  }

  // Merge multi-currency rows into a single per-day COP total
  const dayTotalMap = new Map<string, bigint>();
  for (const row of rows) {
    const currency = row.currency as "COP" | "USD";
    const rawCents = BigInt(row.totalCents);
    const cop = toCop(rawCents, currency, copPerUsd);
    const existing = dayTotalMap.get(row.dayStr) ?? BigInt(0);
    dayTotalMap.set(row.dayStr, existing + cop);
  }

  // Convert to PerDayTotal array
  const perDay: PerDayTotal[] = [];
  for (const [dayStr, cop] of dayTotalMap) {
    perDay.push({ day: new Date(dayStr + "T00:00:00Z"), cop });
  }

  // Compute all three insights
  const heatmapBuckets = computeDailyHeatmap(today, perDay);
  const expensiveDays = detectExpensiveDays(perDay, today);
  const seasonality = detectSeasonality(perDay, today);

  const hasNoData = heatmapBuckets.every((b) => b.bin === "none");

  return {
    dayBuckets: heatmapBuckets.map((b) => ({
      ...b,
      copCents: b.copCents.toString(),
    })),
    expensiveDays,
    seasonality,
    hasNoData,
  };
}
