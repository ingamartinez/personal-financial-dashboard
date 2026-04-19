import { isNull } from "drizzle-orm";
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
