import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailReceipts } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { createLogger } from "@/lib/logger";
import type { GmailAmbiguousReceipt } from "@/lib/types";

const log = createLogger({ module: "gmail/ambiguous" });

/**
 * Sidecar query for /transactions page. After `listTransactions` returns a
 * page of rows, call this function to attach any ambiguous Gmail receipts
 * that point at those tx IDs.
 *
 * Returns a Map<txId, GmailAmbiguousReceipt[]> so the caller can attach each
 * receipt array to the matching TxRow without a second round-trip.
 *
 * Tenant isolation: scoped to `userId` on both the receipt row and the
 * JSONB containment filter. An attacker cannot enumerate another user's tx_ids
 * because the WHERE clause always includes `user_id = $userId`.
 *
 * JSONB lookup: `match_candidates` stores number[]. The query uses an
 * unnested element scan (EXISTS subquery) that Postgres can satisfy with
 * the partial GIN index created in migration 0056.
 */
export async function loadAmbiguousReceiptsForTxIds(
  userId: number,
  txIds: number[],
): Promise<Map<number, GmailAmbiguousReceipt[]>> {
  if (txIds.length === 0) {
    return new Map();
  }

  // Build a Postgres integer array literal for the ANY() filter.
  // e.g. ARRAY[1,2,3]::int[]
  const txIdArray = sql`ARRAY[${sql.join(
    txIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::int[]`;

  const rows = await db
    .select({
      id: emailReceipts.id,
      gateway: emailReceipts.gateway,
      merchant: emailReceipts.merchant,
      amountCents: emailReceipts.amountCents,
      currency: emailReceipts.currency,
      occurredAt: emailReceipts.occurredAt,
      matchCandidates: emailReceipts.matchCandidates,
    })
    .from(emailReceipts)
    .where(
      and(
        eq(emailReceipts.userId, userId),
        eq(emailReceipts.matchStatus, "ambiguous"),
        notDeleted(emailReceipts.deletedAt),
        // Containment check: at least one element in match_candidates is in txIds.
        // Uses an EXISTS + unnest subquery which the GIN index can satisfy.
        sql`EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(${emailReceipts.matchCandidates}) e
          WHERE e::int = ANY(${txIdArray})
        )`,
      ),
    );

  log.debug(
    {
      userId,
      txIdsCount: txIds.length,
      receiptsFound: rows.length,
      event: "ambiguous_receipts_loaded",
    },
    "loaded ambiguous receipts for tx page",
  );

  const result = new Map<number, GmailAmbiguousReceipt[]>();

  for (const row of rows) {
    if (!row.matchCandidates) continue;

    const receipt: GmailAmbiguousReceipt = {
      id: row.id,
      gateway: row.gateway,
      merchant: row.merchant,
      // amountCents stored as bigint; serialize to string for JSON transport
      amountCents: row.amountCents != null ? String(row.amountCents) : "0",
      currency: row.currency ?? "COP",
      occurredAt: row.occurredAt != null ? row.occurredAt.toISOString() : "",
    };

    // Attach this receipt to every tx in match_candidates that is on the
    // current page. We filter to only visible tx_ids to avoid leaking info
    // about tx_ids the current user cannot see (not possible due to user_id
    // scoping above, but belt-and-suspenders).
    const txIdSet = new Set(txIds);
    for (const cand of row.matchCandidates) {
      if (!txIdSet.has(cand)) continue;
      const existing = result.get(cand) ?? [];
      existing.push(receipt);
      result.set(cand, existing);
    }
  }

  return result;
}
