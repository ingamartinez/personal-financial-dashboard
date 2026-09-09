import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailReceipts } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { createLogger } from "@/lib/logger";
import { processPendingEnrichReceipts } from "@/lib/gmail/pull";

const log = createLogger({ module: "gmail/reparse-mercado-pago" });

export type ReparseReport = {
  reset: number;
  users: number;
};

function unmatchedMercadoPagoWhere(userId?: number) {
  const conditions = [
    eq(emailReceipts.gateway, "mercado_pago"),
    inArray(emailReceipts.matchStatus, ["pending", "unmatched"] as const),
    notDeleted(emailReceipts.deletedAt),
  ];
  if (userId !== undefined) conditions.push(eq(emailReceipts.userId, userId));
  return and(...conditions);
}

/**
 * Count unmatched/pending Mercado Pago receipts that a reparse would reset.
 * Dry-run uses this so the script can report without writing.
 */
export async function countUnmatchedMercadoPagoReceipts(opts?: {
  userId?: number;
}): Promise<number> {
  const rows = await db
    .select({ id: emailReceipts.id })
    .from(emailReceipts)
    .where(unmatchedMercadoPagoWhere(opts?.userId));
  return rows.length;
}

/**
 * Clear parse fields on unmatched/pending Mercado Pago receipts so
 * `processPendingEnrichReceipts` will run the (now voucher-aware) parser
 * again. Does not touch `matched` or `ambiguous` rows.
 */
export async function resetUnmatchedMercadoPagoForReparse(opts?: {
  userId?: number;
}): Promise<{ reset: number; userIds: number[] }> {
  const updated = await db
    .update(emailReceipts)
    .set({
      merchant: null,
      amountCents: null,
      currency: null,
      occurredAt: null,
      referenceId: null,
      parsedPayload: null,
      parsedAt: null,
      matchStatus: "pending",
      matchedTransactionId: null,
      matchCandidates: null,
      updatedAt: new Date(),
    })
    .where(unmatchedMercadoPagoWhere(opts?.userId))
    .returning({ id: emailReceipts.id, userId: emailReceipts.userId });

  const userIds = [...new Set(updated.map((r) => r.userId))];
  return { reset: updated.length, userIds };
}

/**
 * Re-parse every unmatched/pending Mercado Pago receipt with the current
 * parser, then run the enrich matcher. Used by the #814 backfill to recover
 * the silent all-NULL rows and any voucher-block mail ingested after the
 * Mercado Libre senders were added.
 */
export async function reparseUnmatchedMercadoPagoReceipts(opts?: {
  userId?: number;
}): Promise<ReparseReport> {
  const { reset, userIds } = await resetUnmatchedMercadoPagoForReparse(opts);
  for (const id of userIds) {
    await processPendingEnrichReceipts(id, "mercado_pago");
  }
  log.info(
    { reset, users: userIds.length, event: "mp_reparse_completed" },
    "mercado_pago receipts reparsed",
  );
  return { reset, users: userIds.length };
}
