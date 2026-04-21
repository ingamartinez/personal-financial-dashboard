import { and, eq, isNull } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import { recurringGaps, recurringTransactions, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { emit } from "@/lib/events/bus";
import {
  DEFAULT_WINDOW_AFTER_DAYS,
  DEFAULT_WINDOW_BEFORE_DAYS,
} from "@/lib/recurring/gap-detector";

export type AutoLinkResult =
  | { status: "no-open-gap" }
  | { status: "already-linked" }
  | { status: "ambiguous"; candidateCount: number }
  | { status: "linked"; gapId: number; recurringId: number; yearMonth: string };

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Called after a new transaction is inserted by any ingestion flow (SMS,
 * Apple Pay, OCR, CSV, manual). Looks for an unresolved gap whose recurring
 * matches the tx by account + amount + expected window.
 *
 * Rules:
 *   - If tx already has a recurring_id, skip (another flow linked it).
 *   - If exactly ONE gap matches, link the tx and delete the gap.
 *   - If multiple gaps match, do nothing — let the user resolve from the inbox
 *     (ambiguity is rare; same amount from same account in same window = edge).
 *   - If no gap matches, done (the common case for brand-new months before
 *     the cron has run).
 */
export async function autoLinkTransaction(
  userId: number,
  txId: number,
  database: DB = defaultDb,
): Promise<AutoLinkResult> {
  const [tx] = await database
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountCents: transactions.amountCents,
      occurredAt: transactions.occurredAt,
      recurringId: transactions.recurringId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.id, txId),
        notDeleted(transactions.deletedAt),
      ),
    )
    .limit(1);

  if (!tx) return { status: "no-open-gap" };
  if (tx.recurringId) return { status: "already-linked" };

  const candidates = await database
    .select({
      gapId: recurringGaps.id,
      gapYearMonth: recurringGaps.yearMonth,
      recurringId: recurringTransactions.id,
      recurringAccountId: recurringTransactions.accountId,
      recurringAmountCents: recurringTransactions.amountCents,
      dayOfMonth: recurringTransactions.dayOfMonth,
    })
    .from(recurringGaps)
    .innerJoin(recurringTransactions, eq(recurringTransactions.id, recurringGaps.recurringId))
    .where(
      and(
        eq(recurringGaps.userId, userId),
        eq(recurringTransactions.accountId, tx.accountId),
        eq(recurringTransactions.amountCents, tx.amountCents),
      ),
    );

  const matching = candidates.filter((c) => {
    const [y, m] = c.gapYearMonth.split("-").map(Number);
    const effectiveDay = Math.min(c.dayOfMonth, daysInMonth(y, m));
    const expected = new Date(Date.UTC(y, m - 1, effectiveDay));
    const windowStart = new Date(expected.getTime() - DEFAULT_WINDOW_BEFORE_DAYS * 86400000);
    const windowEnd = new Date(
      expected.getTime() + DEFAULT_WINDOW_AFTER_DAYS * 86400000 + 86399999,
    );
    const t = tx.occurredAt.getTime();
    return t >= windowStart.getTime() && t <= windowEnd.getTime();
  });

  if (matching.length === 0) return { status: "no-open-gap" };
  if (matching.length > 1) return { status: "ambiguous", candidateCount: matching.length };

  const hit = matching[0];

  const result = await database.transaction(async (trx) => {
    await trx
      .update(transactions)
      .set({
        recurringId: hit.recurringId,
        recurringYearMonth: hit.gapYearMonth,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.id, txId),
          isNull(transactions.recurringId),
        ),
      );

    await trx
      .delete(recurringGaps)
      .where(and(eq(recurringGaps.userId, userId), eq(recurringGaps.id, hit.gapId)));

    return {
      status: "linked" as const,
      gapId: hit.gapId,
      recurringId: hit.recurringId,
      yearMonth: hit.gapYearMonth,
    };
  });

  emit({
    type: "recurring-gap:resolved",
    gapId: result.gapId,
    reason: "auto-linked",
    timestamp: Date.now(),
  });

  return result;
}
