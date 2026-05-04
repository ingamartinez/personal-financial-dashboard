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
 * Internal-movement filter for expense/income aggregation queries. Use in
 * `.where(...)` on any query that computes real spend or income (dashboard
 * flow, category breakdown, budgets, insights). Excludes ALL internal money
 * movements — both transfers between accounts (`channel = 'transfer'`) and
 * ATM cash withdrawals (`channel = 'cash_withdrawal'`) — that are NOT real
 * expenses or income.
 *
 * Including transfers causes double-counting: a TC payment appears as an
 * expense here AND as a purchase on the card. ATM withdrawals move cash to
 * the user's wallet — the spend happens later when the cash is used.
 * See memory `pago-tc-modeled-as-expense`, issues #685 and #766.
 *
 * Exception — do NOT apply this filter when querying debt payments
 * (e.g. `getMonthlyProgress.debtRows` in dashboard/queries.ts) because TC
 * payments on credit_card accounts represent real debt reduction and must
 * be counted. That query is intentionally scoped to credit_card accounts,
 * making this filter redundant and incorrect there.
 *
 * Convention: every query aggregating expense MUST include all three:
 *   notDeleted(transactions.deletedAt)
 *   notAdjustment(transactions.isAdjustment)
 *   notInternalMovement(transactions.channel)
 */
export function notInternalMovement(channel: AnyPgColumn) {
  return sql`${channel} NOT IN ('transfer', 'cash_withdrawal')`;
}

/**
 * @deprecated Use `notInternalMovement` — this alias exists only for the
 * migration period and will be removed once all callers are updated.
 */
export const notTransfer = notInternalMovement;
