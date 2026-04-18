import { and, asc, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import {
  accounts,
  categories,
  recurringGaps,
  recurringTransactions,
  transactions,
} from "@/lib/db/schema";
import {
  DEFAULT_WINDOW_AFTER_DAYS,
  DEFAULT_WINDOW_BEFORE_DAYS,
} from "@/lib/recurring/gap-detector";
import type { Currency } from "@/lib/types";

export type OpenGap = {
  gapId: number;
  recurringId: number;
  yearMonth: string;
  label: string;
  accountId: number;
  accountName: string;
  amountCents: bigint;
  currency: Currency;
  categorySlug: string | null;
  categoryName: string | null;
  dayOfMonth: number;
  notes: string | null;
  detectedAt: Date;
};

export type LinkCandidate = {
  txId: number;
  occurredAt: Date;
  amountCents: bigint;
  descriptionRaw: string;
  merchant: string | null;
};

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Find existing transactions that could plausibly resolve a gap: same account,
 * still unlinked (recurring_id IS NULL), within the match window around the
 * recurring's expected day for the gap's month. Returned sorted by proximity
 * to the expected date is nice-to-have — for now, order by occurredAt desc so
 * the most recent candidate shows first.
 */
export async function getLinkCandidates(
  userId: number,
  gapId: number,
  database: DB = defaultDb,
): Promise<LinkCandidate[]> {
  const [gap] = await database
    .select({
      yearMonth: recurringGaps.yearMonth,
      accountId: recurringTransactions.accountId,
      dayOfMonth: recurringTransactions.dayOfMonth,
    })
    .from(recurringGaps)
    .innerJoin(recurringTransactions, eq(recurringTransactions.id, recurringGaps.recurringId))
    .where(and(eq(recurringGaps.userId, userId), eq(recurringGaps.id, gapId)))
    .limit(1);
  if (!gap) return [];

  const [y, m] = gap.yearMonth.split("-").map(Number);
  const effectiveDay = Math.min(gap.dayOfMonth, daysInMonth(y, m));
  const expected = new Date(Date.UTC(y, m - 1, effectiveDay));
  const windowStart = new Date(expected.getTime() - DEFAULT_WINDOW_BEFORE_DAYS * 86400000);
  const windowEnd = new Date(expected.getTime() + DEFAULT_WINDOW_AFTER_DAYS * 86400000 + 86399999);

  return database
    .select({
      txId: transactions.id,
      occurredAt: transactions.occurredAt,
      amountCents: transactions.amountCents,
      descriptionRaw: transactions.descriptionRaw,
      merchant: transactions.merchant,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.accountId, gap.accountId),
        isNull(transactions.recurringId),
        gte(transactions.occurredAt, windowStart),
        lte(transactions.occurredAt, windowEnd),
      ),
    )
    .orderBy(desc(transactions.occurredAt));
}

export async function getOpenGaps(userId: number, database: DB = defaultDb): Promise<OpenGap[]> {
  const rows = await database
    .select({
      gapId: recurringGaps.id,
      recurringId: recurringTransactions.id,
      yearMonth: recurringGaps.yearMonth,
      label: recurringTransactions.label,
      accountId: recurringTransactions.accountId,
      accountName: accounts.name,
      amountCents: recurringTransactions.amountCents,
      currency: recurringTransactions.currency,
      categorySlug: recurringTransactions.categorySlug,
      categoryName: categories.name,
      dayOfMonth: recurringTransactions.dayOfMonth,
      notes: recurringTransactions.notes,
      detectedAt: recurringGaps.detectedAt,
    })
    .from(recurringGaps)
    .innerJoin(recurringTransactions, eq(recurringTransactions.id, recurringGaps.recurringId))
    .innerJoin(accounts, eq(accounts.id, recurringTransactions.accountId))
    .leftJoin(categories, eq(categories.slug, recurringTransactions.categorySlug))
    .where(eq(recurringGaps.userId, userId))
    .orderBy(asc(recurringGaps.yearMonth), asc(recurringTransactions.dayOfMonth));

  return rows;
}
