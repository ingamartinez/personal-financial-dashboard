import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import { accounts, categories, recurringTransactions, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { formatAccountLabel } from "@/lib/accounts/format";
import { createLogger } from "@/lib/logger";
import {
  DEFAULT_WINDOW_AFTER_DAYS,
  DEFAULT_WINDOW_BEFORE_DAYS,
} from "@/lib/recurring/gap-detector";
import type { Currency } from "@/lib/types";

const log = createLogger({ module: "recurring/upcoming" });

// Default window for getUpcomingForWindow (#632).
export const UPCOMING_WINDOW_BEFORE_DAYS = 5;
export const UPCOMING_WINDOW_AFTER_DAYS = 5;

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

// ---------------------------------------------------------------------------
// getUpcomingForWindow (#632)
// ---------------------------------------------------------------------------
// Returns un-matched recurring slots whose expectedDate falls in the window
// [today - beforeDays, today + afterDays]. Unlike getUpcomingForMonth this:
//   - Can span month boundaries (e.g., today=Apr 29, window includes May 1).
//   - Only returns "esperado" / "atrasado" statuses (filters out matched/dismissed).
//   - Sorted by expectedDate ascending.
// ---------------------------------------------------------------------------

export type UpcomingWindowOptions = {
  userId: number;
  today: Date;
  beforeDays?: number;
  afterDays?: number;
  matchWindowBeforeDays?: number;
  matchWindowAfterDays?: number;
};

export async function getUpcomingForWindow(
  opts: UpcomingWindowOptions,
  database: DB = defaultDb,
): Promise<UpcomingItem[]> {
  try {
    return await getUpcomingForWindowImpl(opts, database);
  } catch (err) {
    log.error(
      { err, userId: opts.userId, event: "upcoming_window_failed" },
      "upcoming window query failed",
    );
    throw err;
  }
}

async function getUpcomingForWindowImpl(
  opts: UpcomingWindowOptions,
  database: DB,
): Promise<UpcomingItem[]> {
  const {
    userId,
    today,
    beforeDays = UPCOMING_WINDOW_BEFORE_DAYS,
    afterDays = UPCOMING_WINDOW_AFTER_DAYS,
    matchWindowBeforeDays = DEFAULT_WINDOW_BEFORE_DAYS,
    matchWindowAfterDays = DEFAULT_WINDOW_AFTER_DAYS,
  } = opts;

  const todayDate = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  const windowStart = new Date(todayDate.getTime() - beforeDays * 86400000);
  const windowEnd = new Date(todayDate.getTime() + afterDays * 86400000);

  // Fetch all active, non-deleted recurrings for this user.
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
      skippedMonths: recurringTransactions.skippedMonths,
      notes: recurringTransactions.notes,
    })
    .from(recurringTransactions)
    .innerJoin(
      accounts,
      and(
        eq(accounts.id, recurringTransactions.accountId),
        // Tenant safety: pair user_id on both sides per per-user-table-join-tenant-safety.
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

  // For each recurring we need to evaluate up to 3 year-months: the ones whose
  // expectedDate might fall within the window. We consider prev-month, current-month
  // (relative to windowStart), and next-month.
  // Derive the set of year-months to evaluate.
  const startYear = windowStart.getUTCFullYear();
  const startMonth = windowStart.getUTCMonth() + 1; // 1-based
  const endYear = windowEnd.getUTCFullYear();
  const endMonth = windowEnd.getUTCMonth() + 1;

  // Collect all unique (year, month) combos spanned by [windowStart, windowEnd].
  const ymSet: Array<{ year: number; month: number; ym: string }> = [];
  let y = startYear;
  let m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    ymSet.push({ year: y, month: m, ym: `${y}-${String(m).padStart(2, "0")}` });
    if (m === 12) {
      y += 1;
      m = 1;
    } else {
      m += 1;
    }
  }

  // Fetch explicit links for these year-months in one query.
  const recurringIds = rows.map((r) => r.id);
  const ymStrings = ymSet.map((e) => e.ym);

  // We need explicit links for ALL year-months in the window.
  // A single `inArray` on recurringYearMonth covers all relevant months.
  const explicitLinks = await database
    .select({
      id: transactions.id,
      recurringId: transactions.recurringId,
      recurringYearMonth: transactions.recurringYearMonth,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        inArray(transactions.recurringId, recurringIds),
        inArray(transactions.recurringYearMonth, ymStrings),
        notDeleted(transactions.deletedAt),
      ),
    );

  // Map: `${recurringId}:${yearMonth}` → txId
  const explicitMap = new Map<string, number>();
  for (const e of explicitLinks) {
    if (e.recurringId !== null && e.recurringYearMonth !== null) {
      explicitMap.set(`${e.recurringId}:${e.recurringYearMonth}`, e.id);
    }
  }

  // Heuristic: unlinked txs in a broad range around the window for fallback matching.
  const heuristicWindowStart = new Date(windowStart.getTime() - matchWindowBeforeDays * 86400000);
  const heuristicWindowEnd = new Date(
    windowEnd.getTime() + matchWindowAfterDays * 86400000 + 86399999,
  );
  const nearbyTxs = await database
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
        gte(transactions.occurredAt, heuristicWindowStart),
        lte(transactions.occurredAt, heuristicWindowEnd),
        isNull(transactions.recurringId),
        notDeleted(transactions.deletedAt),
      ),
    );

  const items: UpcomingItem[] = [];

  for (const r of rows) {
    for (const { year, month, ym } of ymSet) {
      const monthDays = daysInMonth(year, month);
      const day = Math.min(r.dayOfMonth, monthDays);
      const expectedOn = toIso(year, month, day);
      const expectedDate = new Date(`${expectedOn}T00:00:00Z`);

      // Only include if expectedDate falls within [windowStart, windowEnd].
      if (expectedDate < windowStart || expectedDate > windowEnd) continue;

      // Check skipped.
      const isDismissed = (r.skippedMonths ?? []).includes(ym);
      if (isDismissed) continue;

      // Check explicit link.
      const explicitTxId = explicitMap.get(`${r.id}:${ym}`);
      if (explicitTxId !== undefined) continue; // already matched — skip

      // Heuristic fallback: tx in same account + same amount in match window.
      const matchHeurStart = new Date(expectedDate.getTime() - matchWindowBeforeDays * 86400000);
      const matchHeurEnd = new Date(
        expectedDate.getTime() + matchWindowAfterDays * 86400000 + 86399999,
      );
      const heuristicMatch = nearbyTxs.find(
        (tx) =>
          tx.accountId === r.accountId &&
          tx.amountCents === r.amountCents &&
          tx.occurredAt >= matchHeurStart &&
          tx.occurredAt <= matchHeurEnd,
      );
      if (heuristicMatch) continue; // already covered — skip

      // Determine status.
      const status: UpcomingStatus = expectedDate <= todayDate ? "overdue" : "upcoming";

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
        matchedTransactionId: null,
        yearMonth: ym,
        notes: r.notes,
      });
    }
  }

  // Sort by expectedDate ascending.
  items.sort((a, b) => (a.expectedOn < b.expectedOn ? -1 : a.expectedOn > b.expectedOn ? 1 : 0));

  return items;
}
