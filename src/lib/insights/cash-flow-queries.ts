/**
 * Cash flow forecast queries for the /insights page card.
 *
 * Server-side only — no BullMQ / ioredis transitively pulled in.
 * Queries are called in real-time by the /insights RSC.
 *
 * The forecast is computed on every page load (pure function, no caching).
 * The stored `cash_flow_forecast_state` is used only by the daily worker for
 * change-detection; the page always derives a fresh result.
 */

import { and, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  cashFlowForecastState,
  recurringLinkObservations,
  recurringTransactions,
} from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { derivedBalanceCentsSql } from "@/lib/accounts/queries";
import { getCurrentFxRate } from "@/lib/fx/repo";
import {
  computeForecast30d,
  type AccountBalance,
  type ForecastObservation,
  type ForecastRecurring,
  type ForecastResult,
} from "./cash-flow";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CashFlowSummary = {
  /** Computed on the server — fresh result. */
  forecast: ForecastResult;
  /** ISO string of shortfall date, or undefined if no shortfall. */
  shortfallDate?: string;
  /** How many days until the shortfall from today. */
  daysUntilShortfall?: number;
  /** Color band for the UI card. */
  colorBand: "rose" | "amber" | "emerald";
  /** Last time the state was persisted by the daily worker (for display). */
  lastComputedAt?: Date;
};

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Compute a fresh 30-day cash flow forecast for the /insights page card.
 *
 * @param userId  Authenticated user id.
 * @param today   Reference date (defaults to now). Injected for testability.
 */
export async function fetchCashFlowSummary(
  userId: number,
  today: Date = new Date(),
): Promise<CashFlowSummary> {
  const fx = await getCurrentFxRate();
  const copPerUsd = fx.rate;

  // Fetch accounts (non-deleted)
  const accountRows = await db
    .select({
      currency: accounts.currency,
      balanceCents: derivedBalanceCentsSql,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), notDeleted(accounts.deletedAt)));

  const accountBalances: AccountBalance[] = accountRows
    .filter((r) => r.currency === "COP" || r.currency === "USD")
    .map((r) => ({
      currency: r.currency as "COP" | "USD",
      balanceCents: BigInt(r.balanceCents),
    }));

  // Fetch live recurrings
  const recurringRows = await db
    .select({
      id: recurringTransactions.id,
      amountCents: recurringTransactions.amountCents,
      currency: recurringTransactions.currency,
      dayOfMonth: recurringTransactions.dayOfMonth,
      amountType: recurringTransactions.amountType,
    })
    .from(recurringTransactions)
    .where(
      and(
        eq(recurringTransactions.userId, userId),
        eq(recurringTransactions.active, true),
        notDeleted(recurringTransactions.deletedAt),
      ),
    );

  const forecastRecurrings: ForecastRecurring[] = recurringRows
    .filter((r) => r.currency === "COP" || r.currency === "USD")
    .map((r) => ({
      id: r.id,
      amountCents: r.amountCents,
      currency: r.currency as "COP" | "USD",
      dayOfMonth: r.dayOfMonth,
      amountType: r.amountType,
    }));

  // Fetch recent observations (last 90 days) for variable-amount estimation.
  // The date filter is applied in SQL to avoid pulling unbounded history into JS.
  const obs90dAgo = new Date(today.getTime() - 90 * 86400000);
  const observationRows = await db
    .select({
      recurringId: recurringLinkObservations.recurringId,
      realAmountCents: recurringLinkObservations.realAmountCents,
      realCurrency: recurringLinkObservations.realCurrency,
      observedAt: recurringLinkObservations.observedAt,
    })
    .from(recurringLinkObservations)
    .where(
      and(
        eq(recurringLinkObservations.userId, userId),
        gte(recurringLinkObservations.observedAt, obs90dAgo),
      ),
    );

  const forecastObservations: ForecastObservation[] = observationRows
    .filter((r) => r.realCurrency === "COP" || r.realCurrency === "USD")
    .map((r) => ({
      recurringId: r.recurringId,
      realAmountCents: r.realAmountCents,
      realCurrency: r.realCurrency as "COP" | "USD",
      observedAt: r.observedAt,
    }));

  const forecast = computeForecast30d({
    today,
    accounts: accountBalances,
    recurrings: forecastRecurrings,
    observations: forecastObservations,
    copPerUsd,
  });

  // Load persisted state (last worker run time)
  const [stateRow] = await db
    .select({ computedAt: cashFlowForecastState.computedAt })
    .from(cashFlowForecastState)
    .where(eq(cashFlowForecastState.userId, userId));

  // Compute color band
  let colorBand: CashFlowSummary["colorBand"] = "emerald";
  let daysUntilShortfall: number | undefined;

  if (forecast.shortfallDate !== undefined) {
    const shortfallMs = new Date(forecast.shortfallDate).getTime() - today.getTime();
    daysUntilShortfall = Math.ceil(shortfallMs / 86400000);

    if (daysUntilShortfall <= 7) {
      colorBand = "rose";
    } else {
      colorBand = "amber";
    }
  }

  return {
    forecast,
    shortfallDate: forecast.shortfallDate,
    daysUntilShortfall,
    colorBand,
    lastComputedAt: stateRow?.computedAt ?? undefined,
  };
}
