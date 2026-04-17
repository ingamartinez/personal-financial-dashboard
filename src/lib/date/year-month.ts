const YM_RE = /^\d{4}-\d{2}$/;

export function isValidYearMonth(s: string): boolean {
  if (!YM_RE.test(s)) return false;
  const [, m] = s.split("-").map(Number);
  return m >= 1 && m <= 12;
}

export function currentYearMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function parseYearMonthOrCurrent(input: string | undefined, now: Date = new Date()): string {
  return input && isValidYearMonth(input) ? input : currentYearMonth(now);
}

export function shiftYearMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function refDateFromYearMonth(ym: string): Date {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1));
}

export function isFutureYearMonth(ym: string, now: Date = new Date()): boolean {
  return ym > currentYearMonth(now);
}

export function formatYearMonth(ym: string, locale = "es-CO"): string {
  return refDateFromYearMonth(ym).toLocaleDateString(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
