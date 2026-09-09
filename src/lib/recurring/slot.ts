// #804: Non-overlapping "occurrence slot" math for recurring transactions.
//
// Replaces the old fixed ±10/+5 day window (DEFAULT_WINDOW_BEFORE_DAYS /
// DEFAULT_WINDOW_AFTER_DAYS) with a slot-claiming rule: a transaction claims
// the occurrence whose effective due date is the most recent at-or-before the
// transaction date, with a lookahead grace for early payment.
//
// Formally: for a recurring with a given dayOfMonth, occurrence m's window is
//   [due(m) - graceDays, due(m+1) - graceDays)
// Since due(m) increases strictly month-over-month, these windows partition
// the entire timeline with no gaps and no overlaps — a transaction date maps
// to exactly one occurrence, however late (or how many days early, up to the
// grace) it was paid.
//
// This fixes the "day-1 recurring paid on day 20 matches nothing" bug: the
// old fixed window ended 5 days after the due date, so a 19-day-late payment
// fell outside every month's window. Under the new rule it correctly claims
// its own (overdue) month, because due(next month) - grace is still weeks away.

export const LATE_PAYMENT_GRACE_DAYS = 10;

const DAY_MS = 86400000;

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Adds `offset` months to (year, month), 1-based month, with rollover. */
export function addMonths(
  year: number,
  month: number,
  offset: number,
): { year: number; month: number } {
  const zeroBased = month - 1 + offset;
  const y = year + Math.floor(zeroBased / 12);
  const m = ((zeroBased % 12) + 12) % 12;
  return { year: y, month: m + 1 };
}

export function yearMonthOf(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * The effective due date for a recurring's occurrence in a given month,
 * clamping dayOfMonth to the month's actual length (e.g. day 31 in February
 * clamps to the 28th/29th).
 */
export function effectiveDueDate(year: number, month: number, dayOfMonth: number): Date {
  const day = Math.min(dayOfMonth, daysInMonth(year, month));
  return new Date(Date.UTC(year, month - 1, day));
}

export type Occurrence = { year: number; month: number; ym: string };

/**
 * The non-overlapping claim window for occurrence (year, month): starts
 * `graceDays` before its own due date, ends `graceDays` before the NEXT
 * occurrence's due date (exclusive).
 */
export function occurrenceWindow(
  year: number,
  month: number,
  dayOfMonth: number,
  graceDays: number = LATE_PAYMENT_GRACE_DAYS,
): { start: Date; endExclusive: Date } {
  const grace = graceDays * DAY_MS;
  const due = effectiveDueDate(year, month, dayOfMonth).getTime();
  const next = addMonths(year, month, 1);
  const nextDue = effectiveDueDate(next.year, next.month, dayOfMonth).getTime();
  return { start: new Date(due - grace), endExclusive: new Date(nextDue - grace) };
}

/**
 * Determine which occurrence (year/month) a transaction date claims for a
 * recurring with the given dayOfMonth, per the slot-claiming rule: the
 * largest due(m) such that due(m) <= txDate + graceDays.
 *
 * Evaluates a small window of candidate months around the tx's own month —
 * sufficient because due dates step by roughly a month while grace is small
 * (default 10 days), so the answer is always the tx's month, the month
 * before, or the month after.
 */
export function claimSlotForTx(
  occurredAt: Date,
  dayOfMonth: number,
  graceDays: number = LATE_PAYMENT_GRACE_DAYS,
): Occurrence {
  const t = occurredAt.getTime();
  const grace = graceDays * DAY_MS;
  const baseYear = occurredAt.getUTCFullYear();
  const baseMonth = occurredAt.getUTCMonth() + 1;

  let best: { year: number; month: number; due: number } | null = null;
  for (const offset of [-1, 0, 1]) {
    const { year, month } = addMonths(baseYear, baseMonth, offset);
    const due = effectiveDueDate(year, month, dayOfMonth).getTime();
    if (due <= t + grace && (best === null || due > best.due)) {
      best = { year, month, due };
    }
  }

  // In practice `best` is always set — the previous month's due date is
  // always <= t + grace. Fall back to the tx's own month defensively.
  const { year, month } = best ?? { year: baseYear, month: baseMonth };
  return { year, month, ym: yearMonthOf(year, month) };
}
