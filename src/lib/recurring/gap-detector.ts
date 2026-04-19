import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import { recurringGaps, recurringTransactions, transactions, users } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";

const DEFAULT_WINDOW_BEFORE_DAYS = 10;
const DEFAULT_WINDOW_AFTER_DAYS = 5;

export type DetectResult = {
  yearMonth: string;
  checkedRecurrings: number;
  existingLinks: number;
  autoLinked: number;
  skippedIntentionally: number;
  gapsCreated: number;
  gapsAlreadyOpen: number;
};

export type DetectOptions = {
  matchWindowBeforeDays?: number;
  matchWindowAfterDays?: number;
};

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseYearMonth(ym: string): { year: number; month: number } {
  const [year, month] = ym.split("-").map(Number);
  if (!year || !month || month < 1 || month > 12) {
    throw new Error(`invalid yearMonth: ${ym}`);
  }
  return { year, month };
}

export function previousYearMonth(today: Date): string {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const prev = new Date(Date.UTC(y, m - 1, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * For a single closed month, reconcile every active recurring against
 * transactions. Three branches per recurring:
 *   1. Already linked (recurring_id + recurring_year_month set on a tx) — done.
 *   2. A tx with matching account + amount exists in the expected window but
 *      with no recurring_id yet — auto-link it.
 *   3. Otherwise — insert into recurring_gaps for manual resolution.
 *
 * skippedMonths entries on the recurring are respected: those months are not
 * gaps, the user already said "this month was intentionally not paid".
 *
 * Idempotent: re-running on the same month is a no-op thanks to the unique
 * index on recurring_gaps(recurring_id, year_month) + ON CONFLICT DO NOTHING
 * and the unique link index on transactions.
 */
export async function detectGapsForMonth(
  userId: number,
  yearMonth: string,
  database: DB = defaultDb,
  opts: DetectOptions = {},
): Promise<DetectResult> {
  const { year, month } = parseYearMonth(yearMonth);
  const before = opts.matchWindowBeforeDays ?? DEFAULT_WINDOW_BEFORE_DAYS;
  const after = opts.matchWindowAfterDays ?? DEFAULT_WINDOW_AFTER_DAYS;

  const monthDays = daysInMonth(year, month);

  const recurrings = await database
    .select({
      id: recurringTransactions.id,
      accountId: recurringTransactions.accountId,
      amountCents: recurringTransactions.amountCents,
      dayOfMonth: recurringTransactions.dayOfMonth,
      skippedMonths: recurringTransactions.skippedMonths,
    })
    .from(recurringTransactions)
    .where(
      and(
        eq(recurringTransactions.userId, userId),
        eq(recurringTransactions.active, true),
        notDeleted(recurringTransactions.deletedAt),
      ),
    );

  const result: DetectResult = {
    yearMonth,
    checkedRecurrings: recurrings.length,
    existingLinks: 0,
    autoLinked: 0,
    skippedIntentionally: 0,
    gapsCreated: 0,
    gapsAlreadyOpen: 0,
  };

  if (recurrings.length === 0) return result;

  const recurringIds = recurrings.map((r) => r.id);

  const existingLinks = await database
    .select({ recurringId: transactions.recurringId })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        inArray(transactions.recurringId, recurringIds),
        eq(transactions.recurringYearMonth, yearMonth),
      ),
    );
  const linkedSet = new Set(existingLinks.map((l) => l.recurringId as number));

  for (const r of recurrings) {
    if (linkedSet.has(r.id)) {
      result.existingLinks += 1;
      continue;
    }

    if ((r.skippedMonths ?? []).includes(yearMonth)) {
      result.skippedIntentionally += 1;
      continue;
    }

    const effectiveDay = Math.min(r.dayOfMonth, monthDays);
    const expectedDate = new Date(Date.UTC(year, month - 1, effectiveDay));
    const windowStart = new Date(expectedDate.getTime() - before * 86400000);
    const windowEnd = new Date(expectedDate.getTime() + after * 86400000 + 86399999);

    const candidates = await database
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.accountId, r.accountId),
          eq(transactions.amountCents, r.amountCents),
          isNull(transactions.recurringId),
          gte(transactions.occurredAt, windowStart),
          lte(transactions.occurredAt, windowEnd),
        ),
      )
      .limit(2);

    if (candidates.length === 1) {
      await database
        .update(transactions)
        .set({
          recurringId: r.id,
          recurringYearMonth: yearMonth,
          updatedAt: new Date(),
        })
        .where(and(eq(transactions.userId, userId), eq(transactions.id, candidates[0].id)));
      result.autoLinked += 1;
      continue;
    }

    const inserted = await database
      .insert(recurringGaps)
      .values({
        userId,
        recurringId: r.id,
        yearMonth,
      })
      .onConflictDoNothing({
        target: [recurringGaps.recurringId, recurringGaps.yearMonth],
      })
      .returning({ id: recurringGaps.id });

    if (inserted.length > 0) {
      result.gapsCreated += 1;
    } else {
      result.gapsAlreadyOpen += 1;
    }
  }

  return result;
}

/**
 * Entry point for the cron. Closes the month PRIOR to `today` so that
 * late-posting SMS/Apple Pay events have a 4-day grace window before we
 * finalize gaps.
 */
export async function closePreviousMonth(
  userId: number,
  today: Date = new Date(),
  database: DB = defaultDb,
): Promise<DetectResult> {
  return detectGapsForMonth(userId, previousYearMonth(today), database);
}

export type UserCloseResult =
  | { userId: number; ok: true; result: DetectResult }
  | { userId: number; ok: false; error: unknown };

/**
 * Fan-out wrapper for the monthly cron. Runs closePreviousMonth for every
 * user sequentially; a failure on one user is captured and does not stop the
 * rest. Callers are responsible for logging / alerting on the returned list.
 */
export async function closePreviousMonthForAllUsers(
  today: Date = new Date(),
  database: DB = defaultDb,
): Promise<UserCloseResult[]> {
  const rows = await database.select({ id: users.id }).from(users).orderBy(asc(users.id));
  const out: UserCloseResult[] = [];
  for (const { id } of rows) {
    try {
      const result = await closePreviousMonth(id, today, database);
      out.push({ userId: id, ok: true, result });
    } catch (error) {
      out.push({ userId: id, ok: false, error });
    }
  }
  return out;
}

export { DEFAULT_WINDOW_BEFORE_DAYS, DEFAULT_WINDOW_AFTER_DAYS };
