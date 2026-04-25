/**
 * Pure types + formatters for financial-period rendering. Lives in its own
 * module so client components can import it without dragging the server-only
 * `db` import chain (`period.ts` reaches into postgres.js + auth + drizzle).
 *
 * Anything that touches the database stays in `./period.ts`.
 */

export type FinancialPeriodFallback =
  | "no_salary_flagged"
  | "insufficient_history"
  | "no_recent_paycheck";

export type FinancialPeriod = {
  start: Date;
  end: Date;
  mode: "calendar" | "pay_period";
  fallbackReason?: FinancialPeriodFallback;
};

/**
 * Format the period's date range for card subtitles. Returns `null` when
 * the period is calendar — callers should fall back to the existing
 * "abril 2026" label in that case.
 *
 * Display convention: the end label is "the day before the next anchor"
 * because both calendar and pay-period ends are exclusive (next-period
 * boundary), so `end - 1d` is the last day fully inside this period.
 */
export function formatPeriodDateRange(period: FinancialPeriod, locale = "es-CO"): string | null {
  if (period.mode !== "pay_period") return null;
  const oneDay = 24 * 60 * 60 * 1000;
  const lastDay = new Date(period.end.getTime() - oneDay);
  const fmt = (d: Date) =>
    d.toLocaleDateString(locale, { day: "numeric", month: "short", timeZone: "UTC" });
  return `${fmt(period.start)} — ${fmt(lastDay)}`;
}

/**
 * Inline note to render below the subtitle when the period helper degraded
 * to calendar despite the user being in pay_period mode. `null` when no
 * note is needed (calendar-mode-by-choice or successful pay_period).
 */
export function periodFallbackNote(period: FinancialPeriod): string | null {
  if (!period.fallbackReason) return null;
  return "Sin datos de sueldo · mostrando mes calendario";
}
