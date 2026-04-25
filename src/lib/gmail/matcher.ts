import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailReceipts, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { createLogger } from "@/lib/logger";
import { getGatewayById } from "@/lib/gmail/registry";

const log = createLogger({ module: "gmail/matcher" });

// ±2 days expressed in milliseconds.
const MATCH_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

export type MatchResult =
  | { status: "matched"; transactionId: number }
  | { status: "ambiguous"; candidateIds: number[] }
  | { status: "unmatched" };

/**
 * Find the bank transaction that corresponds to an email receipt.
 *
 * Tenant isolation: both the receipt load and the transactions JOIN are
 * scoped by `userId`. The function throws if the receipt is not found under
 * the given userId (cross-tenant attempt or stale id).
 *
 * Only runs on enrich-mode gateways. If called on an ingest-mode gateway
 * (e.g. bancolombia) it throws — the pull engine should never route those
 * receipts here, but this is a defense-in-depth guard.
 */
export async function matchReceipt(userId: number, receiptId: number): Promise<MatchResult> {
  // Load receipt scoped by (id, userId) — throw on mismatch to prevent
  // cross-tenant data exposure.
  const [receipt] = await db
    .select({
      id: emailReceipts.id,
      userId: emailReceipts.userId,
      gateway: emailReceipts.gateway,
      amountCents: emailReceipts.amountCents,
      occurredAt: emailReceipts.occurredAt,
    })
    .from(emailReceipts)
    .where(and(eq(emailReceipts.id, receiptId), eq(emailReceipts.userId, userId)));

  if (!receipt) {
    throw new Error(`[gmail/matcher] receipt ${receiptId} not found for user ${userId}`);
  }

  if (!receipt.amountCents || !receipt.occurredAt) {
    log.info(
      { userId, receiptId, event: "matcher_receipt_unparsed" },
      "receipt has no amountCents or occurredAt; unmatched",
    );
    return { status: "unmatched" };
  }

  // Defense-in-depth: matcher must never run on ingest-mode gateways.
  const gateway = getGatewayById(receipt.gateway);
  if (!gateway.bankDescriptionRegex) {
    throw new Error(
      `[gmail/matcher] gateway ${receipt.gateway} is ingest-mode (bankDescriptionRegex is null); matcher must not run on it`,
    );
  }

  // Adapt the JS regex source for PostgreSQL POSIX (`~*`).
  // `\b` is a word-boundary in JS regex but a literal backspace (ASCII 8) in
  // POSIX ERE — strip it so the pattern degrades gracefully to a substring
  // match (still accurate enough for bank description tokens like MERCADOPAGO,
  // PAYPAL, WOMPI which are unlikely to appear as sub-tokens in other words).
  const posixPattern = gateway.bankDescriptionRegex.source.replace(/\\b/g, "");

  const windowStart = new Date(receipt.occurredAt.getTime() - MATCH_WINDOW_MS);
  const windowEnd = new Date(receipt.occurredAt.getTime() + MATCH_WINDOW_MS);

  // Receipts store the amount as a positive value (what the user paid), but
  // bank transactions store expenses as negative. Match both signs so a
  // receipt for 65990 matches a transaction with -65990 (purchase) or +65990
  // (unusual but covers manual/CSV imports with inverted sign conventions).
  const positiveAmount =
    receipt.amountCents < BigInt(0) ? -receipt.amountCents : receipt.amountCents;
  const negativeAmount = -positiveAmount;

  const candidates = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        // Tenant safety: every constraint includes userId as a top-level guard.
        eq(transactions.userId, userId),
        sql`(${transactions.amountCents} = ${positiveAmount} OR ${transactions.amountCents} = ${negativeAmount})`,
        gte(transactions.occurredAt, windowStart),
        lte(transactions.occurredAt, windowEnd),
        // Gateway regex match — case-insensitive POSIX (~*). Uses posixPattern
        // (not the raw .source) because \b is a backspace in POSIX ERE, not a
        // word boundary — see the adaptation comment above.
        sql`${transactions.descriptionRaw} ~* ${posixPattern}`,
        // Exclude already-enriched transactions (another receipt already claimed them).
        isNull(transactions.enrichedMerchant),
        // Exclude soft-deleted transactions.
        notDeleted(transactions.deletedAt),
      ),
    );

  log.info(
    {
      userId,
      receiptId,
      candidateCount: candidates.length,
      gateway: receipt.gateway,
      event: "matcher_candidates",
    },
    "matcher found candidates",
  );

  if (candidates.length === 0) return { status: "unmatched" };
  if (candidates.length === 1) return { status: "matched", transactionId: candidates[0].id };
  return { status: "ambiguous", candidateIds: candidates.map((c) => c.id) };
}
