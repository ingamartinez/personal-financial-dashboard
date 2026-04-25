import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailReceipts } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "gmail/disambiguate" });

/**
 * Apply a rejection decision: remove `transactionId` from the
 * `match_candidates` array of every ambiguous receipt for `userId` that still
 * references it. When a receipt's candidate list becomes empty after removal,
 * its `match_status` is flipped to `'unmatched'`.
 *
 * Tenant isolation: every query is scoped by `userId`.
 *
 * Returns the number of receipts updated.
 */
export async function applyRejection(
  userId: number,
  transactionId: number,
): Promise<{ rejected: number }> {
  // Fetch all ambiguous receipts that still list this tx as a candidate.
  const candidates = await db
    .select({ id: emailReceipts.id, matchCandidates: emailReceipts.matchCandidates })
    .from(emailReceipts)
    .where(
      and(
        eq(emailReceipts.userId, userId),
        eq(emailReceipts.matchStatus, "ambiguous"),
        notDeleted(emailReceipts.deletedAt),
        sql`${emailReceipts.matchCandidates} @> ${JSON.stringify([transactionId])}::jsonb`,
      ),
    );

  let updated = 0;
  for (const row of candidates) {
    const remaining = (row.matchCandidates ?? []).filter((id) => id !== transactionId);
    await db
      .update(emailReceipts)
      .set({
        matchCandidates: remaining.length > 0 ? remaining : [],
        matchStatus: remaining.length === 0 ? "unmatched" : "ambiguous",
        updatedAt: new Date(),
      })
      .where(and(eq(emailReceipts.id, row.id), eq(emailReceipts.userId, userId)));
    updated++;
  }

  log.info(
    { userId, transactionId, count: updated, event: "disambiguation_rejected" },
    "disambiguation rejected — candidates released",
  );

  return { rejected: updated };
}
