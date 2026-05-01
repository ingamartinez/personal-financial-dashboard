import { eq, isNull, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * Soft-delete filter. Use in `.where(...)` clauses on tables that have a
 * `deleted_at TIMESTAMPTZ NULL` column to exclude archived rows.
 *
 * Opt-in to include archived rows by simply omitting this from the where
 * clause (no `includeDeleted` flag — explicit by absence is clearer than
 * a boolean parameter that gets forwarded through call chains).
 */
export function notDeleted(deletedAt: AnyPgColumn) {
  return isNull(deletedAt);
}

/**
 * Adjustment filter for transaction queries. Use in `.where(...)` when the
 * query should represent *real* spend/income (insights, dashboard top-N,
 * budgets). Balance and net-worth queries should NOT use this — adjustments
 * represent real money that landed in the account.
 *
 * Adjustments come from `adjustAccountBalance` (reconciliation — YNAB pattern).
 * Never use `eq(transactions.isAdjustment, false)` by hand; use this helper so
 * the intent is greppable and uniform across the codebase.
 */
export function notAdjustment(isAdjustment: AnyPgColumn) {
  return eq(isAdjustment, false);
}

/**
 * Transfer filter for expense/income aggregation queries. Use in `.where(...)`
 * on any query that computes real spend or income (dashboard flow, category
 * breakdown, budgets, insights). Transfers have `channel = 'transfer'` and
 * represent internal money movements — including TC payments (pago-tc) and
 * TC credit received — that are NOT real expenses or income.
 *
 * Including transfers in expense aggregations causes double-counting: a TC
 * payment appears as an expense here AND as a purchase on the card.
 * See memory `pago-tc-modeled-as-expense` and issue #685.
 *
 * Exception — do NOT apply this filter when querying debt payments
 * (e.g. `getMonthlyProgress.debtRows` in dashboard/queries.ts) because TC
 * payments on credit_card accounts represent real debt reduction and must
 * be counted. That query is intentionally scoped to credit_card accounts,
 * making the transfer filter redundant and incorrect there.
 *
 * Convention: every query aggregating expense MUST include all three:
 *   notDeleted(transactions.deletedAt)
 *   notAdjustment(transactions.isAdjustment)
 *   notTransfer(transactions.channel)
 */
export function notTransfer(channel: AnyPgColumn) {
  return sql`${channel} <> 'transfer'`;
}
