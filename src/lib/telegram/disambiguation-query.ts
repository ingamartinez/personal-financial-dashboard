import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailReceipts, transactions, accounts } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { createLogger } from "@/lib/logger";
import { formatAccountLabel } from "@/lib/accounts/format";
import type { DisambiguationCandidate } from "@/lib/telegram/formatter";

const log = createLogger({ module: "telegram/disambiguation-query" });

export type PendingAmbiguousReceipt = {
  receipt: {
    id: number;
    merchant: string | null;
    occurredAt: Date | null;
  };
  candidates: DisambiguationCandidate[];
};

/**
 * Load the oldest ambiguous email receipt for a user that:
 * - has match_status = 'ambiguous'
 * - has a non-null match_candidates array
 * - has been parsed (parsed_at IS NOT NULL)
 * - is not soft-deleted
 *
 * Returns null when there are no pending receipts.
 */
export async function loadPendingAmbiguousReceipt(
  userId: number,
): Promise<PendingAmbiguousReceipt | null> {
  const [receiptRow] = await db
    .select({
      id: emailReceipts.id,
      merchant: emailReceipts.merchant,
      occurredAt: emailReceipts.occurredAt,
      matchCandidates: emailReceipts.matchCandidates,
    })
    .from(emailReceipts)
    .where(
      and(
        eq(emailReceipts.userId, userId),
        eq(emailReceipts.matchStatus, "ambiguous"),
        notDeleted(emailReceipts.deletedAt),
        isNotNull(emailReceipts.parsedAt),
        isNotNull(emailReceipts.matchCandidates),
      ),
    )
    .orderBy(asc(emailReceipts.createdAt))
    .limit(1);

  if (!receiptRow) return null;

  const candidateIds = receiptRow.matchCandidates ?? [];
  if (candidateIds.length === 0) return null;

  // Load candidate transactions. Filter by userId to enforce tenant safety.
  const txRows = await db
    .select({
      id: transactions.id,
      occurredAt: transactions.occurredAt,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      descriptionRaw: transactions.descriptionRaw,
      accountId: transactions.accountId,
    })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), inArray(transactions.id, candidateIds)));

  if (txRows.length === 0) {
    log.warn(
      {
        userId,
        receiptId: receiptRow.id,
        candidateIds,
        event: "disambiguation_candidates_missing",
      },
      "ambiguous receipt has no resolvable transaction candidates",
    );
    return null;
  }

  // Load accounts for candidate transactions (tenant-safe: via transaction rows already scoped).
  const accountIds = [...new Set(txRows.map((t) => t.accountId))];
  const accountRows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      institution: accounts.institution,
      currency: accounts.currency,
      metadata: accounts.metadata,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), inArray(accounts.id, accountIds)));

  const accountMap = new Map(accountRows.map((a) => [a.id, a]));

  const candidates: DisambiguationCandidate[] = txRows.map((t) => {
    const acc = accountMap.get(t.accountId);
    const accountLabel = acc
      ? formatAccountLabel(acc, { withInstitution: true, withLast4: true })
      : `cuenta #${t.accountId}`;
    return {
      id: t.id,
      occurredAt: t.occurredAt,
      amountCents: t.amountCents,
      currency: t.currency as "COP" | "USD",
      descriptionRaw: t.descriptionRaw,
      accountLabel,
    };
  });

  // Preserve candidate ordering from the matchCandidates array.
  candidates.sort((a, b) => candidateIds.indexOf(a.id) - candidateIds.indexOf(b.id));

  return {
    receipt: {
      id: receiptRow.id,
      merchant: receiptRow.merchant,
      occurredAt: receiptRow.occurredAt,
    },
    candidates,
  };
}
