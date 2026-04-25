import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailReceipts, transactions } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import { reclassifyTransaction, type ReclassifyDb } from "@/lib/classification/reclassify";

const log = createLogger({ module: "gmail/enrich" });

/**
 * Apply enrichment from a matched email receipt to the corresponding
 * bank transaction, then trigger retroactive reclassification.
 *
 * Everything runs inside a single Drizzle transaction so a mid-way failure
 * rolls back both the transactions update and the email_receipts update.
 *
 * Tenant isolation: both rows are verified to belong to `userId` before any
 * mutation. A mismatch throws `Error("cross-tenant attempt")` — the error
 * message is intentionally stable so callers can match on it in tests.
 */
export async function applyEnrichment(
  userId: number,
  txId: number,
  receiptId: number,
): Promise<void> {
  await db.transaction(async (trx) => {
    // Verify the transaction belongs to this user.
    const [tx] = await trx
      .select({
        id: transactions.id,
        userId: transactions.userId,
        descriptionRaw: transactions.descriptionRaw,
      })
      .from(transactions)
      .where(and(eq(transactions.id, txId), eq(transactions.userId, userId)));

    if (!tx) {
      throw new Error("cross-tenant attempt: transaction does not belong to user");
    }

    // Verify the receipt belongs to this user.
    const [receipt] = await trx
      .select({
        id: emailReceipts.id,
        userId: emailReceipts.userId,
        merchant: emailReceipts.merchant,
      })
      .from(emailReceipts)
      .where(and(eq(emailReceipts.id, receiptId), eq(emailReceipts.userId, userId)));

    if (!receipt) {
      throw new Error("cross-tenant attempt: receipt does not belong to user");
    }

    // Update the transaction with enriched merchant data.
    // NEVER modify descriptionRaw — it is the immutable audit field.
    await trx
      .update(transactions)
      .set({
        enrichedMerchant: receipt.merchant,
        enrichmentSource: "gmail",
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.id, txId), eq(transactions.userId, userId)));

    // Update the receipt to reflect the match.
    await trx
      .update(emailReceipts)
      .set({
        matchedTransactionId: txId,
        matchStatus: "matched",
        updatedAt: new Date(),
      })
      .where(and(eq(emailReceipts.id, receiptId), eq(emailReceipts.userId, userId)));

    // Trigger retroactive reclassification inside the same DB transaction
    // so rule updates and enrichment are atomic. Cast trx to ReclassifyDb
    // (the PgTransaction union type) which is structurally compatible.
    await reclassifyTransaction(userId, txId, trx as ReclassifyDb);
  });

  log.info(
    { userId, txId, receiptId, event: "gmail_enrichment_applied" },
    "gmail enrichment applied",
  );
}
