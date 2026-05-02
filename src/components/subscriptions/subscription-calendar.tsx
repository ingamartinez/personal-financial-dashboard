"use client";

import { addDays, format, getDate, getMonth, getYear, isSameMonth } from "date-fns";
import { es } from "date-fns/locale";
import { Calendar } from "@/components/ui/calendar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatMoney } from "@/lib/money";
import type { SubscriptionRow } from "@/app/(app)/subscriptions/queries";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SubscriptionCalendarProps {
  rows: SubscriptionRow[];
  excludedIds: Set<number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function absCents(cents: bigint): bigint {
  return cents < BigInt(0) ? -cents : cents;
}

/** Determine the dot color class based on the highest tier represented. */
function dotColorClass(hasTier: "top" | "medianas" | "pequeñas" | null): string {
  if (hasTier === "top") return "bg-emerald-600";
  if (hasTier === "medianas") return "bg-emerald-400";
  return "bg-emerald-300";
}

// ---------------------------------------------------------------------------
// UpcomingCharges sub-component (exported separately too)
// ---------------------------------------------------------------------------

interface UpcomingChargesProps {
  rows: SubscriptionRow[];
  excludedIds: Set<number>;
  today?: Date;
}

export function UpcomingCharges({ rows, excludedIds, today: todayProp }: UpcomingChargesProps) {
  const rawToday = todayProp ?? new Date();
  // Floor to midnight so same-day charges aren't excluded by time comparison.
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

          return (
            <li key={row.id} className="text-muted-foreground flex items-center gap-2 text-sm">
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

// ---------------------------------------------------------------------------
// Main Calendar component
// ---------------------------------------------------------------------------

export function SubscriptionCalendar({ rows, excludedIds }: SubscriptionCalendarProps) {
  const today = new Date();
  const currentYear = getYear(today);
  const currentMonth = getMonth(today); // 0-indexed

  // Active (non-excluded) rows only.
  const activeRows = rows.filter((row) => !excludedIds.has(row.id));

  // Build a Map<dayOfMonth, SubscriptionRow[]> for the current month.
  // Only include subs whose nextOccurrence falls in the current month.
  const byDay = new Map<number, SubscriptionRow[]>();

  for (const row of activeRows) {
    const nextDate = new Date(row.nextOccurrence + "T00:00:00");
    if (getYear(nextDate) === currentYear && getMonth(nextDate) === currentMonth) {
      const day = getDate(nextDate);
      const existing = byDay.get(day) ?? [];
      byDay.set(day, [...existing, row]);
    }
  }

  // Determine tier color per day (based on highest tier in that day's subs).
  // We compute tiers on the fly for color assignment:
  // For simplicity: a sub is "top" if it's the highest-spend sub overall.
  // We use the classifyTiers result passed implicitly via row ordering.
  // Since tiers are computed in the orchestrator, we pass pre-classified info
  // via a simple heuristic: top 30% of rows by spend = "top", next 20% = "medianas", rest = "pequeñas".
  // Actually: classifyTiers is a pure function — we can call it here directly.
  // But SubscriptionCalendar doesn't receive tier info directly.
  // Solution: compute it inline from the rows sorted by spend.

  // Sort rows by abs displayAmount descending to assign tiers for color.
  const sorted = [...activeRows].sort((a, b) => {
    const aAbs = absCents(a.displayAmount.cents);
    const bAbs = absCents(b.displayAmount.cents);
    if (bAbs > aAbs) return 1;
    if (bAbs < aAbs) return -1;
    return a.id - b.id;
  });

  const grandTotal = sorted.reduce((acc, r) => acc + absCents(r.displayAmount.cents), BigInt(0));

  // Assign tier per row id using the same Pareto thresholds.
  const rowTiers = new Map<number, "top" | "medianas" | "pequeñas">();
  if (grandTotal > BigInt(0)) {
    let cumulative = BigInt(0);
    let topSatisfied = false;
    let medianasSatisfied = false;
    const threshold70 = grandTotal * BigInt(70);
    const threshold90 = grandTotal * BigInt(90);

    for (const row of sorted) {
      const abs = absCents(row.displayAmount.cents);
      cumulative += abs;
      const cumulativePct100 = cumulative * BigInt(100);

      if (!topSatisfied) {
        rowTiers.set(row.id, "top");
        if (cumulativePct100 >= threshold70) topSatisfied = true;
      } else if (!medianasSatisfied) {
        rowTiers.set(row.id, "medianas");
        if (cumulativePct100 >= threshold90) medianasSatisfied = true;
      } else {
        rowTiers.set(row.id, "pequeñas");
      }
    }
  }

  // Build the modifiers: one key per unique color, dates array.
  const chargeTopDates: Date[] = [];
  const chargeMedianasDates: Date[] = [];
  const chargePequeñasDates: Date[] = [];
  const multiChargeDays = new Set<number>(); // days with > 1 sub

  for (const [day, dayRows] of byDay) {
    const date = new Date(currentYear, currentMonth, day);
    // Get highest tier for the day.
    const tiers = dayRows.map((r) => rowTiers.get(r.id) ?? "pequeñas");
    const highestTier = tiers.includes("top")
      ? "top"
      : tiers.includes("medianas")
        ? "medianas"
        : "pequeñas";

    if (highestTier === "top") chargeTopDates.push(date);
    else if (highestTier === "medianas") chargeMedianasDates.push(date);
    else chargePequeñasDates.push(date);

    if (dayRows.length > 1) multiChargeDays.add(day);
  }

  const modifiers = {
    chargeTop: chargeTopDates,
    chargeMedianas: chargeMedianasDates,
    chargePequeñas: chargePequeñasDates,
  };

  const modifiersClassNames = {
    chargeTop: "rdp-day-charge rdp-day-charge-top",
    chargeMedianas: "rdp-day-charge rdp-day-charge-medianas",
    chargePequeñas: "rdp-day-charge rdp-day-charge-pequeñas",
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Calendar title */}
      <div className="flex items-center gap-2">
        <div className="bg-border h-px flex-1" />
        <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Calendario del mes
        </span>
        <div className="bg-border h-px flex-1" />
      </div>

      <TooltipProvider>
        <div className="flex justify-center">
          <div className="relative">
            <Calendar
              mode={undefined}
              month={new Date(currentYear, currentMonth, 1)}
              disableNavigation
              modifiers={modifiers}
              modifiersClassNames={modifiersClassNames}
              components={{
                DayButton: ({ day, modifiers: _dayModifiers, children, ...props }) => {
                  const dayNum = getDate(day.date);
                  // Only show tooltip for charge days in current month.
                  const dayRows = byDay.get(dayNum);
                  const isCurrentMonth = isSameMonth(
                    day.date,
                    new Date(currentYear, currentMonth, 1),
                  );
                  const isCharge = !!dayRows && isCurrentMonth;

                  // Determine dot color.
                  const tier = isCharge
                    ? chargeTopDates.some((d) => isSameMonth(d, day.date) && getDate(d) === dayNum)
                      ? "top"
                      : chargeMedianasDates.some(
                            (d) => isSameMonth(d, day.date) && getDate(d) === dayNum,
                          )
                        ? "medianas"
                        : "pequeñas"
                    : null;

                  const multiCount = dayRows && dayRows.length > 1 ? dayRows.length : null;

                  const dayButton = (
                    <button
                      {...props}
                      type="button"
                      className="hover:bg-muted/50 relative flex aspect-square w-full min-w-[var(--cell-size,28px)] flex-col items-center justify-center gap-0.5 rounded-[var(--cell-radius,4px)] p-0 text-sm font-normal"
                    >
                      <span>{children}</span>
                      {isCharge && tier && (
                        <span
                          className="absolute bottom-0.5 flex items-center justify-center"
                          data-testid="charge-dot"
                        >
                          <span
                            className={`size-1.5 rounded-full ${dotColorClass(tier)}`}
                            aria-hidden
                          />
                          {multiCount && (
                            <span
                              className="ml-0.5 text-[8px] font-bold text-emerald-700 tabular-nums dark:text-emerald-300"
                              data-testid="multi-charge-badge"
                            >
                              +{multiCount}
                            </span>
                          )}
                        </span>
                      )}
                    </button>
                  );

                  if (!isCharge || !dayRows) return dayButton;

                  return (
                    <Tooltip>
                      <TooltipTrigger asChild>{dayButton}</TooltipTrigger>
                      <TooltipContent side="top" className="flex flex-col gap-1">
                        {dayRows.map((row) => {
                          const absDisplayCents = absCents(row.displayAmount.cents);
                          return (
                            <p key={row.id} className="text-xs">
                              <span className="font-medium">{row.label}</span>
                              {" — "}
                              <span className="tabular-nums">
                                {row.amountType === "variable" ? "~" : ""}
                                {formatMoney(
                                  absDisplayCents,
                                  row.displayAmount.currency as "COP" | "USD",
                                )}
                              </span>
                            </p>
                          );
                        })}
                      </TooltipContent>
                    </Tooltip>
                  );
                },
              }}
            />
          </div>
        </div>
      </TooltipProvider>

      {/* Próximos 7 días */}
      <UpcomingCharges rows={rows} excludedIds={excludedIds} />
    </div>
  );
}
