/**
 * Cash flow detection — D.3 salary-gap detection + D.4 30-day forecast.
 * Part of Epic I (#255), issue #715.
 *
 * D.3 — Salary-gap detector:
 *   A recurring transaction classified as income (category in INCOME_CATEGORY_SLUGS
 *   OR amountCents > 0 with a non-null categorySlug as fallback) didn't arrive
 *   within dayOfMonth + 3 grace days. Fires per-month, idempotent by entityId.
 *
 * D.4 — 30-day cash flow forecast:
 *   Project account balances day-by-day for the next 30 days using live
 *   recurring transactions. Variable-amount recurrings use the median of the
 *   last 3 observations; fixed use recurringTransactions.amountCents.
 *   Multi-currency amounts are converted to COP for the projected balance.
 *
 * Pure functions are exported for unit tests (no DB, no side-effects).
 * `runSalaryGapForUser` and `runCashFlowForecastForUser` are the DB-driven
 * entry points called from the daily BullMQ worker.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import {
  cashFlowForecastState,
  recurringLinkObservations,
  recurringTransactions,
  transactions,
} from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { toCop } from "@/lib/money";
import { emitNotification } from "@/lib/notifications/emit";
import { createLogger } from "@/lib/logger";
import { derivedBalanceCentsSql } from "@/lib/accounts/queries";
import { accounts } from "@/lib/db/schema";

const log = createLogger({ module: "insights/cash-flow" });

// ---------------------------------------------------------------------------
// Income category slugs — salary-gap eligibility whitelist
//
// Derived from seed-reference-data.ts:
//   { slug: "ingresos" }  ← parent
//   { slug: "salario", parentSlug: "ingresos" }
//   { slug: "freelance", parentSlug: "ingresos" }
//   { slug: "reembolso", parentSlug: "ingresos" }
//   { slug: "regalo-recibido", parentSlug: "ingresos" }
//   { slug: "otros-ingresos", parentSlug: "ingresos" }
//
// Only salary-grade income makes sense for gap detection (recurring payslips);
// reembolso/regalo are excluded because they are irregular and not expected on
// a fixed day. "ingresos" (parent) is included so that custom recurrings
// assigned to the parent still trigger.
// ---------------------------------------------------------------------------
export const INCOME_CATEGORY_SLUGS: ReadonlySet<string> = new Set([
  "salario",
  "ingresos",
  "freelance",
  "sueldo", // alias guard — if user creates this custom slug
]);

// Grace window: the recurring is considered "on time" if a tx appeared in
// [dayOfMonth - 5, today]. The detector fires when today >= dayOfMonth + 3
// AND still no tx in that window.
// GRACE_DAYS_BEFORE: how far back we look for a matching tx (5 days before dayOfMonth).
// Not used in pure detection (we defer to the observation/link tables instead of
// date-range scanning), but kept as documentation of the design contract.
const GRACE_DAYS_TRIGGER = 3;

// ---------------------------------------------------------------------------
// Pure helper — zero-pad month/day
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Format a Date as "YYYY-MM" string using UTC fields (avoids TZ drift).
 */
export function toYearMonth(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/**
 * Format a Date as "YYYY-MM-DD" string using UTC fields.
 */
export function toDateString(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// ---------------------------------------------------------------------------
// D.3 — Pure salary-gap detection logic
// ---------------------------------------------------------------------------

export type RecurringIncomeSummary = {
  id: number;
  label: string;
  amountCents: bigint;
  dayOfMonth: number;
  skippedMonths: string[];
  active: boolean;
  categorySlug: string | null;
};

export type ObservedTxSummary = {
  recurringId: number;
  /** ISO year-month the tx was linked to (recurring_year_month on tx). */
  yearMonth: string;
};

export type SalaryGapResult =
  | { hasGap: false; reason: string }
  | {
      hasGap: true;
      recurringId: number;
      label: string;
      dayOfMonth: number;
      yearMonth: string;
    };

/**
 * Pure salary-gap check for a single recurring transaction.
 *
 * Returns hasGap=true if:
 *   1. The recurring is active and not soft-deleted (caller must pre-filter).
 *   2. The category slug is in INCOME_CATEGORY_SLUGS OR amountCents > 0
 *      (income fallback when slug is not set / custom).
 *   3. today.getUTCDate() >= dayOfMonth + GRACE_DAYS_TRIGGER (grace window elapsed).
 *   4. The current yearMonth is NOT in skippedMonths.
 *   5. No observed tx exists for (recurringId, currentYearMonth) in the window.
 *
 * @param now       Reference date (today).
 * @param recurring The recurring transaction to check.
 * @param observed  List of observation records — pre-fetched for the current month.
 */
export function detectSalaryGap(
  now: Date,
  recurring: RecurringIncomeSummary,
  observed: ObservedTxSummary[],
): SalaryGapResult {
  const noGap = (reason: string): SalaryGapResult => ({ hasGap: false, reason });

  if (!recurring.active) return noGap("inactive");

  // Income check: slug in whitelist OR amountCents > 0 with a non-null slug
  const isIncomeByCategorySlug =
    recurring.categorySlug !== null && INCOME_CATEGORY_SLUGS.has(recurring.categorySlug);
  const isIncomeByAmount = recurring.amountCents > BigInt(0);
  if (!isIncomeByCategorySlug && !isIncomeByAmount) {
    return noGap("not-income");
  }

  const ym = toYearMonth(now);
  if (recurring.skippedMonths.includes(ym)) {
    return noGap("skipped-month");
  }

  const todayDom = now.getUTCDate();
  if (todayDom < recurring.dayOfMonth + GRACE_DAYS_TRIGGER) {
    return noGap("grace-window-not-elapsed");
  }

  // Check if any tx was observed for this recurring in the current month
  const hasObservation = observed.some((o) => o.recurringId === recurring.id && o.yearMonth === ym);
  if (hasObservation) {
    return noGap("tx-observed");
  }

  return {
    hasGap: true,
    recurringId: recurring.id,
    label: recurring.label,
    dayOfMonth: recurring.dayOfMonth,
    yearMonth: ym,
  };
}

// ---------------------------------------------------------------------------
// D.4 — Pure 30-day forecast logic
// ---------------------------------------------------------------------------

export type ForecastRecurring = {
  id: number;
  amountCents: bigint;
  currency: "COP" | "USD";
  dayOfMonth: number;
  amountType: "fixed" | "variable";
};

export type ForecastObservation = {
  recurringId: number;
  realAmountCents: bigint;
  realCurrency: "COP" | "USD";
  observedAt: Date;
};

export type AccountBalance = {
  currency: "COP" | "USD";
  balanceCents: bigint;
};

export type ForecastInput = {
  today: Date;
  accounts: AccountBalance[];
  recurrings: ForecastRecurring[];
  observations: ForecastObservation[];
  copPerUsd: number;
};

export type DailyBalance = {
  date: string; // "YYYY-MM-DD"
  balanceCop: bigint;
};

export type ForecastResult = {
  projectedDailyBalance: DailyBalance[];
  minBalance: bigint;
  minBalanceDate: string;
  /** First day where balanceCop < 0, undefined if no shortfall. */
  shortfallDate?: string;
};

/**
 * Compute the median of a bigint array. Returns BigInt(0) for empty input.
 */
export function bigintMedian(values: bigint[]): bigint {
  if (values.length === 0) return BigInt(0);
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  // For even-length, average the two middle values
  return (sorted[mid - 1]! + sorted[mid]!) / BigInt(2);
}

/**
 * Estimate the projected amount for a single recurring using observations.
 *
 * For 'variable' recurrings: take the median of the last 3 observations
 * (same currency). Falls back to the recurring's amountCents if no obs.
 * For 'fixed': return the recurring's amountCents directly.
 *
 * Returns COP-equivalent bigint (caller passes copPerUsd for conversion).
 */
export function estimateAmountCop(
  recurring: ForecastRecurring,
  observations: ForecastObservation[],
  copPerUsd: number,
): bigint {
  if (recurring.amountType === "variable") {
    // Use last 3 observations for this recurring, same currency
    const relevantObs = observations
      .filter((o) => o.recurringId === recurring.id && o.realCurrency === recurring.currency)
      .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())
      .slice(0, 3);

    if (relevantObs.length > 0) {
      const median = bigintMedian(relevantObs.map((o) => o.realAmountCents));
      return toCop(median, recurring.currency, copPerUsd);
    }
    // Fallback: use the stored amount
  }

  return toCop(recurring.amountCents, recurring.currency, copPerUsd);
}

/**
 * Pure 30-day cash flow forecast.
 *
 * Starting balance is the sum of all account balances converted to COP.
 * For each of the next 30 days, project deltas from recurrings whose
 * dayOfMonth falls in the window.
 *
 * Does NOT touch the DB. Caller fetches the inputs.
 */
export function computeForecast30d(input: ForecastInput): ForecastResult {
  const { today, copPerUsd } = input;

  // Starting balance in COP
  const startingBalanceCop = input.accounts.reduce((sum, acc) => {
    return sum + toCop(acc.balanceCents, acc.currency, copPerUsd);
  }, BigInt(0));

  const projectedDailyBalance: DailyBalance[] = [];
  let runningBalanceCop = startingBalanceCop;
  let minBalance = runningBalanceCop;
  let minBalanceDate = toDateString(today);
  let shortfallDate: string | undefined;

  for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
    const dayMs = today.getTime() + (dayOffset + 1) * 86400000;
    const dayDate = new Date(dayMs);
    const dayDom = dayDate.getUTCDate();
    const dateStr = toDateString(dayDate);

    // Apply all recurrings whose dayOfMonth matches this calendar day
    for (const recurring of input.recurrings) {
      if (recurring.dayOfMonth === dayDom) {
        const deltaCop = estimateAmountCop(recurring, input.observations, copPerUsd);
        runningBalanceCop = runningBalanceCop + deltaCop;
      }
    }

    projectedDailyBalance.push({ date: dateStr, balanceCop: runningBalanceCop });

    if (runningBalanceCop < minBalance) {
      minBalance = runningBalanceCop;
      minBalanceDate = dateStr;
    }

    if (shortfallDate === undefined && runningBalanceCop < BigInt(0)) {
      shortfallDate = dateStr;
    }
  }

  return {
    projectedDailyBalance,
    minBalance,
    minBalanceDate,
    shortfallDate,
  };
}

// ---------------------------------------------------------------------------
// DB-driven entry points
// ---------------------------------------------------------------------------

/**
 * Run salary-gap detection for a single user.
 *
 * Fetches all active income recurrings and checks whether any expected income
 * is missing in the current month. Emits `salary_gap` notification per gap
 * found. The `entityId` month suffix makes it idempotent within the same month.
 *
 * Called from `cashFlowDailyProcessor` in the daily BullMQ worker.
 */
export async function runSalaryGapForUser(
  userId: number,
  database: DB = defaultDb,
  today: Date = new Date(),
): Promise<{ gapsEmitted: number }> {
  // Fetch active, non-deleted recurrings for this user
  const recurrings = await database
    .select({
      id: recurringTransactions.id,
      label: recurringTransactions.label,
      amountCents: recurringTransactions.amountCents,
      dayOfMonth: recurringTransactions.dayOfMonth,
      skippedMonths: recurringTransactions.skippedMonths,
      active: recurringTransactions.active,
      categorySlug: recurringTransactions.categorySlug,
    })
    .from(recurringTransactions)
    .where(
      and(
        eq(recurringTransactions.userId, userId),
        eq(recurringTransactions.active, true),
        notDeleted(recurringTransactions.deletedAt),
      ),
    );

  if (recurrings.length === 0) return { gapsEmitted: 0 };

  const ym = toYearMonth(today);

  // Fetch observations for the current month for all recurrings of this user
  // Use recurring_link_observations to check for "tx arrived"
  // yearMonth on the observation == the month the tx was linked to
  const observedRows = await database
    .select({
      recurringId: recurringLinkObservations.recurringId,
      yearMonth: recurringLinkObservations.yearMonth,
    })
    .from(recurringLinkObservations)
    .where(
      and(
        eq(recurringLinkObservations.userId, userId),
        eq(recurringLinkObservations.yearMonth, ym),
      ),
    );

  // Also check transactions directly linked to recurrings this month
  // (the observation table may not have been updated yet if auto-link hasn't run)
  const linkedTxRows = await database
    .select({
      recurringId: transactions.recurringId,
      yearMonth: transactions.recurringYearMonth,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        notDeleted(transactions.deletedAt),
        eq(transactions.recurringYearMonth, ym),
        sql`${transactions.recurringId} IS NOT NULL`,
      ),
    );

  // Merge both sources into a unified observed list
  const observed: ObservedTxSummary[] = [
    ...observedRows.map((o) => ({ recurringId: o.recurringId, yearMonth: o.yearMonth })),
    ...linkedTxRows
      .filter(
        (r): r is { recurringId: number; yearMonth: string } =>
          r.recurringId !== null && r.yearMonth !== null,
      )
      .map((r) => ({ recurringId: r.recurringId, yearMonth: r.yearMonth })),
  ];

  let gapsEmitted = 0;

  for (const recurring of recurrings) {
    const result = detectSalaryGap(today, recurring, observed);

    if (!result.hasGap) continue;

    const entityId = `salary-gap:${userId}:${recurring.id}:${ym}`;

    await emitNotification(userId, {
      type: "salary_gap",
      entityId,
      title: "Ingreso no recibido",
      body: `No recibimos tu ingreso de ${recurring.label} (esperado el día ${recurring.dayOfMonth}) — ¿todo bien?`,
      priority: "high",
      actionUrl: "/settings/recurring",
      metadata: {
        recurringId: recurring.id,
        yearMonth: ym,
        dayOfMonth: recurring.dayOfMonth,
        label: recurring.label,
      },
    });

    log.info(
      { userId, recurringId: recurring.id, yearMonth: ym, event: "salary_gap_emitted" },
      "salary gap detected and notification emitted",
    );

    gapsEmitted++;
  }

  return { gapsEmitted };
}

// ---------------------------------------------------------------------------
// D.4 DB-driven forecast + emit
// ---------------------------------------------------------------------------

/**
 * Run the 30-day cash flow forecast for a single user.
 *
 * Fetches current account balances, live recurrings, and recent observations.
 * Emits `cash_flow_forecast` only when the shortfall date changes from what
 * was last stored in `cash_flow_forecast_state`.
 *
 * Returns the computed forecast result.
 */
export async function runCashFlowForecastForUser(
  userId: number,
  copPerUsd: number,
  database: DB = defaultDb,
  today: Date = new Date(),
): Promise<{ forecast: ForecastResult; shortfallChanged: boolean }> {
  // Fetch current account balances (non-deleted, active)
  const accountRows = await database
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

  // Fetch all live recurrings
  const recurringRows = await database
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

  // Fetch recent observations (last 90 days) for variable-amount estimation
  const obs90dAgo = new Date(today.getTime() - 90 * 86400000);
  const observationRows = await database
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

  // Load previous forecast state
  const [prevState] = await database
    .select({
      lastShortfallDate: cashFlowForecastState.lastShortfallDate,
    })
    .from(cashFlowForecastState)
    .where(eq(cashFlowForecastState.userId, userId));

  const prevShortfallDate = prevState?.lastShortfallDate ?? null;
  const newShortfallDate = forecast.shortfallDate ?? "none";

  const shortfallChanged = prevShortfallDate !== newShortfallDate;

  // Upsert the forecast state
  await database
    .insert(cashFlowForecastState)
    .values({
      userId,
      lastShortfallDate: newShortfallDate,
      computedAt: today,
    })
    .onConflictDoUpdate({
      target: cashFlowForecastState.userId,
      set: {
        lastShortfallDate: newShortfallDate,
        computedAt: today,
      },
    });

  // Emit notification only when shortfall changes AND a new shortfall appeared
  if (shortfallChanged && forecast.shortfallDate !== undefined) {
    const entityId = `forecast-shortfall:${userId}:${forecast.shortfallDate}`;

    await emitNotification(userId, {
      type: "cash_flow_forecast",
      entityId,
      title: "Saldo proyectado en rojo",
      body: `El flujo de caja proyectado a 30 días muestra un saldo negativo el ${forecast.shortfallDate}. Revisá tus próximos gastos.`,
      priority: "high",
      actionUrl: "/insights",
      metadata: {
        shortfallDate: forecast.shortfallDate,
        minBalance: String(forecast.minBalance),
        minBalanceDate: forecast.minBalanceDate,
      },
    });

    log.info(
      {
        userId,
        shortfallDate: forecast.shortfallDate,
        prevShortfallDate,
        event: "cash_flow_forecast_emitted",
      },
      "cash flow forecast shortfall notification emitted",
    );
  }

  return { forecast, shortfallChanged };
}
