import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import { accounts, categories, recurringTransactions, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { formatAccountLabel } from "@/lib/accounts/format";
import {
  DEFAULT_WINDOW_AFTER_DAYS,
  DEFAULT_WINDOW_BEFORE_DAYS,
} from "@/lib/recurring/gap-detector";
import type { Currency } from "@/lib/types";

export type UpcomingStatus = "matched" | "upcoming" | "overdue" | "dismissed";

export type UpcomingItem = {
  recurringId: number;
  label: string;
  accountId: number;
  accountName: string;
  amountCents: bigint;
  currency: Currency;
  categorySlug: string | null;
  categoryName: string | null;
  dayOfMonth: number;
  expectedOn: string;
  status: UpcomingStatus;
  matchedTransactionId: number | null;
  yearMonth: string;
  notes: string | null;
};

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function toIso(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

export function yearMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export type UpcomingOptions = {
  userId: number;
  year: number;
  month: number;
  includeDismissed?: boolean;
  includeMatched?: boolean;
  matchWindowBeforeDays?: number;
  matchWindowAfterDays?: number;
  today?: Date;
};

export async function getUpcomingForMonth(
  opts: UpcomingOptions,
  database: DB = defaultDb,
): Promise<UpcomingItem[]> {
  const {
    userId,
    year,
    month,
    includeDismissed = false,
    includeMatched = true,
    matchWindowBeforeDays = DEFAULT_WINDOW_BEFORE_DAYS,
    matchWindowAfterDays = DEFAULT_WINDOW_AFTER_DAYS,
    today = new Date(),
  } = opts;

  const ym = yearMonth(year, month);
  const monthDays = daysInMonth(year, month);
  const rangeStart = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const rangeEnd = new Date(Date.UTC(year, month, 0, 23, 59, 59));

  const rows = await database
    .select({
      id: recurringTransactions.id,
      label: recurringTransactions.label,
      accountId: recurringTransactions.accountId,
      accountName: accounts.name,
      accountCurrency: accounts.currency,
      amountCents: recurringTransactions.amountCents,
      currency: recurringTransactions.currency,
      categorySlug: recurringTransactions.categorySlug,
      categoryName: categories.name,
      dayOfMonth: recurringTransactions.dayOfMonth,
      active: recurringTransactions.active,
      skippedMonths: recurringTransactions.skippedMonths,
      notes: recurringTransactions.notes,
    })
    .from(recurringTransactions)
    .innerJoin(
      accounts,
      and(
        eq(accounts.id, recurringTransactions.accountId),
        // Defense-in-depth tenant pairing per per-user-table-join-tenant-safety.
        eq(accounts.userId, recurringTransactions.userId),
      ),
    )
    .leftJoin(
      categories,
      and(
        eq(categories.slug, recurringTransactions.categorySlug),
        eq(categories.userId, recurringTransactions.userId),
      ),
    )
    .where(
      and(
        eq(recurringTransactions.userId, userId),
        eq(recurringTransactions.active, true),
        notDeleted(recurringTransactions.deletedAt),
      ),
    )
    .orderBy(asc(recurringTransactions.dayOfMonth), asc(recurringTransactions.id));

  if (rows.length === 0) return [];

  // Explicit links trump the heuristic: a tx whose recurringId + recurringYearMonth
  // point to (r.id, ym) is the authoritative match, even if it landed outside
  // the heuristic window or with a different amount (variable recurrings).
  const recurringIds = rows.map((r) => r.id);
  const explicitLinks = await database
    .select({
      id: transactions.id,
      recurringId: transactions.recurringId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        inArray(transactions.recurringId, recurringIds),
        eq(transactions.recurringYearMonth, ym),
        notDeleted(transactions.deletedAt),
      ),
    );
  const explicitMap = new Map<number, number>();
  for (const e of explicitLinks) {
    if (e.recurringId !== null) explicitMap.set(e.recurringId, e.id);
  }

  // Heuristic fallback for txs that ingestion hasn't auto-linked yet (e.g.
  // current-month brand-new SMS before the cron runs). Only considers txs
  // with no recurringId — anything linked is already authoritative above.
  const monthTxs = await database
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountCents: transactions.amountCents,
      occurredAt: transactions.occurredAt,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        gte(
          transactions.occurredAt,
          new Date(rangeStart.getTime() - matchWindowBeforeDays * 86400000),
        ),
        lte(
          transactions.occurredAt,
          new Date(rangeEnd.getTime() + matchWindowAfterDays * 86400000),
        ),
        isNull(transactions.recurringId),
        notDeleted(transactions.deletedAt),
      ),
    );

  const todayDate = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );

  const items: UpcomingItem[] = [];
  for (const r of rows) {
    const day = Math.min(r.dayOfMonth, monthDays);
    const expectedOn = toIso(year, month, day);
    const expectedDate = new Date(`${expectedOn}T00:00:00Z`);
    const windowStart = new Date(expectedDate.getTime() - matchWindowBeforeDays * 86400000);
    const windowEnd = new Date(expectedDate.getTime() + matchWindowAfterDays * 86400000);

    const isDismissed = (r.skippedMonths ?? []).includes(ym);

    const explicitMatchTxId = explicitMap.get(r.id);
    const match = explicitMatchTxId
      ? { id: explicitMatchTxId }
      : monthTxs.find(
          (tx) =>
            tx.accountId === r.accountId &&
            tx.amountCents === r.amountCents &&
            tx.occurredAt >= windowStart &&
            tx.occurredAt <= windowEnd,
        );

    let status: UpcomingStatus;
    let matchedTransactionId: number | null = null;
    if (match) {
      status = "matched";
      matchedTransactionId = match.id;
    } else if (isDismissed) {
      status = "dismissed";
    } else if (expectedDate <= todayDate) {
      status = "overdue";
    } else {
      status = "upcoming";
    }

    if (status === "dismissed" && !includeDismissed) continue;
    if (status === "matched" && !includeMatched) continue;

    items.push({
      recurringId: r.id,
      label: r.label,
      accountId: r.accountId,
      accountName: formatAccountLabel({ name: r.accountName, currency: r.accountCurrency }),
      amountCents: r.amountCents,
      currency: r.currency,
      categorySlug: r.categorySlug,
      categoryName: r.categoryName,
      dayOfMonth: r.dayOfMonth,
      expectedOn,
      status,
      matchedTransactionId,
      yearMonth: ym,
      notes: r.notes,
    });
  }

  return items;
}
