import { DEFAULT_DATE_TOLERANCE_DAYS } from "@/lib/reconciliation/engine/match";

// The XLSX parser anchors every row at midnight Bogotá (05:00 UTC), so a
// real tx recorded at 21:33 Bogotá the same day lives at 02:33 UTC the next
// day — outside the raw [periodStart, periodEnd] range and therefore
// invisible to the matcher, which then duplicates it. Three days of slack
// also covers the legitimate gap between bank-side accounting date and
// Gmail notification date.
export function expandReconcileWindow(
  periodStart: Date,
  periodEnd: Date,
): { windowStart: Date; windowEnd: Date } {
  const toleranceMs = DEFAULT_DATE_TOLERANCE_DAYS * 86_400_000;
  return {
    windowStart: new Date(periodStart.getTime() - toleranceMs),
    windowEnd: new Date(periodEnd.getTime() + toleranceMs),
  };
}
