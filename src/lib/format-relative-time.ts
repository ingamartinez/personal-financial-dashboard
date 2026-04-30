const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto" });

/**
 * Returns a human-readable relative time string in Spanish.
 * Examples: "hace 30 segundos", "hace 2 horas", "ayer", "hace 3 días".
 *
 * @param from - The date to format (e.g. createdAt of a notification).
 * @param to   - The reference "now" date (defaults to new Date()).
 */
export function formatRelativeTime(from: Date, to: Date = new Date()): string {
  const diffSec = Math.floor((from.getTime() - to.getTime()) / 1000);
  const abs = Math.abs(diffSec);

  if (abs < 60) return rtf.format(diffSec, "second");
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
  if (abs < 30 * 86400) return rtf.format(Math.round(diffSec / 86400), "day");
  if (abs < 365 * 86400) return rtf.format(Math.round(diffSec / (30 * 86400)), "month");
  return rtf.format(Math.round(diffSec / (365 * 86400)), "year");
}
