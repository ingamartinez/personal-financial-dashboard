import { and, asc, eq, gte, lte } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import { accounts, categories, recurringTransactions, transactions } from "@/lib/db/schema";

export type UpcomingStatus = "matched" | "upcoming" | "overdue" | "dismissed";

export type UpcomingItem = {
  recurringId: number;
  label: string;
  accountId: number;
  accountName: string;
  amountCents: bigint;
  currency: "COP" | "USD";
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
  year: number;
  month: number;
  includeDismissed?: boolean;
  includeMatched?: boolean;
  matchWindowDays?: number;
  today?: Date;
};

export async function getUpcomingForMonth(
  opts: UpcomingOptions,
  database: DB = defaultDb,
): Promise<UpcomingItem[]> {
  const {
    year,
    month,
    includeDismissed = false,
    includeMatched = true,
    matchWindowDays = 3,
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
    .innerJoin(accounts, eq(accounts.id, recurringTransactions.accountId))
    .leftJoin(categories, eq(categories.slug, recurringTransactions.categorySlug))
    .where(eq(recurringTransactions.active, true))
    .orderBy(asc(recurringTransactions.dayOfMonth), asc(recurringTransactions.id));

  if (rows.length === 0) return [];

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
        gte(transactions.occurredAt, new Date(rangeStart.getTime() - matchWindowDays * 86400000)),
        lte(transactions.occurredAt, new Date(rangeEnd.getTime() + matchWindowDays * 86400000)),
      ),
    );

  const todayDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  const items: UpcomingItem[] = [];
  for (const r of rows) {
    const day = Math.min(r.dayOfMonth, monthDays);
    const expectedOn = toIso(year, month, day);
    const expectedDate = new Date(`${expectedOn}T00:00:00Z`);
    const windowStart = new Date(expectedDate.getTime() - matchWindowDays * 86400000);
    const windowEnd = new Date(expectedDate.getTime() + matchWindowDays * 86400000);

    const isDismissed = (r.skippedMonths ?? []).includes(ym);

    const match = monthTxs.find(
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
      accountName: r.accountName,
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
