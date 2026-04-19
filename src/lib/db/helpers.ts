import { eq, isNull } from "drizzle-orm";
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
