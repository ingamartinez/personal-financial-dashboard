"use client";

import { addDays, format } from "date-fns";
import { es } from "date-fns/locale";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/money";
import type { RecurringRow } from "@/app/(app)/recurring/queries";
import type { UpcomingStatus } from "@/lib/recurring/upcoming";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpcomingChargesProps {
  rows: RecurringRow[];
  excludedIds: Set<number>;
  today?: Date;
  /** When provided, use for status dots instead of computing locally. */
  slotStatusById?: Record<number, UpcomingStatus>;
}

// ---------------------------------------------------------------------------
// Dot color map
// ---------------------------------------------------------------------------

const STATUS_DOT_CLASS: Record<UpcomingStatus, string | null> = {
  matched: "bg-emerald-600",
  upcoming: "bg-sky-500",
  overdue: "bg-rose-600",
  dismissed: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function absCents(cents: bigint): bigint {
  return cents < BigInt(0) ? -cents : cents;
}

// ---------------------------------------------------------------------------
// UpcomingCharges component
// ---------------------------------------------------------------------------

export function UpcomingCharges({
  rows,
  excludedIds,
  today: todayProp,
  slotStatusById,
}: UpcomingChargesProps) {
  const rawToday = todayProp ?? new Date();
  // Floor to midnight so same-day charges are included.
  const today = new Date(rawToday.getFullYear(), rawToday.getMonth(), rawToday.getDate());
  const in7Days = addDays(today, 7);

  const upcoming = rows
    .filter((row) => {
      if (excludedIds.has(row.id)) return false;
      const nextDate = new Date(row.nextOccurrence + "T00:00:00");
      return nextDate >= today && nextDate <= in7Days;
    })
    .sort((a, b) => a.nextOccurrence.localeCompare(b.nextOccurrence));

  if (upcoming.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="bg-border h-px flex-1" />
        <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Próximos 7 días
        </span>
        <div className="bg-border h-px flex-1" />
      </div>
      <ul className="flex flex-col gap-1">
        {upcoming.map((row) => {
          const nextDate = new Date(row.nextOccurrence + "T00:00:00");
          const diffDays = Math.round(
            (nextDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
          );
          const absDisplayCents = absCents(row.displayAmount.cents);
          const formattedDate = format(nextDate, "d MMM", { locale: es });
          const status = slotStatusById?.[row.id];
          const dotClass = status ? STATUS_DOT_CLASS[status] : null;

          return (
            <li key={row.id} className="text-muted-foreground flex items-center gap-2 text-sm">
              {dotClass && (
                <span
                  className={cn("size-2 shrink-0 rounded-full", dotClass)}
                  data-testid="upcoming-status-dot"
                  aria-hidden="true"
                />
              )}
              <span className="text-foreground font-medium">{row.label}</span>
              <span>—</span>
              <span className="tabular-nums">
                {formatMoney(absDisplayCents, row.displayAmount.currency as "COP" | "USD")}
              </span>
              <span>—</span>
              <span>
                {diffDays === 0 ? "hoy" : diffDays === 1 ? "mañana" : `en ${diffDays} días`} (
                {formattedDate})
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
