const PAYMENT_LAG_DAYS = 15;

/**
 * Derives the next payment date from the statement cutoff day (#362).
 * Bancolombia's payment is due ~15 days after the cycle's cutoff. If today is
 * past this cycle's payment date, returns the next cycle's payment date.
 *
 * Returns `YYYY-MM-DD` (anchored at UTC noon so downstream `new Date(...)`
 * parsing can't slip back a day in negative-offset timezones), or `null` when
 * `cutoffDay` is not a valid 1-31 integer.
 *
 * Edge cases:
 * - `cutoffDay=31` in a 28/30-day month: clamps to the last day of the month.
 * - Computes in UTC throughout to avoid DST / timezone drift.
 */
export function computeNextPayment(
  cutoffDay: number | null | undefined,
  today: Date,
): string | null {
  if (cutoffDay == null || !Number.isInteger(cutoffDay) || cutoffDay < 1 || cutoffDay > 31) {
    return null;
  }
  const y = today.getFullYear();
  const m = today.getMonth();
  const thisPayment = makePayment(y, m, cutoffDay);
  const chosen =
    today.getTime() <= thisPayment.getTime() ? thisPayment : makePayment(y, m + 1, cutoffDay);
  return chosen.toISOString().slice(0, 10);
}

function makePayment(year: number, month: number, cutoffDay: number): Date {
  // Clamp cutoff to the month's last day so cutoffDay=31 in Feb becomes 28/29.
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(cutoffDay, lastDayOfMonth);
  const cutoff = new Date(Date.UTC(year, month, day, 12, 0, 0));
  return new Date(cutoff.getTime() + PAYMENT_LAG_DAYS * 24 * 3600 * 1000);
}
