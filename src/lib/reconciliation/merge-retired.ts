import { sql } from "drizzle-orm";
import { transactions } from "@/lib/db/schema";

/**
 * A transaction retired by a reconciliation merge is soft-deleted, exactly like
 * a user-archived one — same `deleted_at`, same shape. They are not the same
 * thing, and the difference matters in exactly one place: restore.
 *
 * Restoring a user-archived transaction brings back a row that has no live
 * counterpart. Restoring a merge-retired one resurrects a duplicate NEXT TO the
 * survivor that absorbed it, double-counting the amount in every balance. That
 * was impossible while the merge hard-deleted its target (#922).
 *
 * The tell needs no new column: the merged-away row is the `merged_into_txn_id`
 * of a recorded decision. Use this predicate wherever archived rows are listed
 * or restored.
 */
export function notMergeRetired() {
  return sql`NOT EXISTS (
    SELECT 1 FROM reconciliation_decisions rd
    WHERE rd.merged_into_txn_id = ${transactions.id}
  )`;
}
