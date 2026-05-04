"use client";

import { useMemo } from "react";
import {
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  getDate,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { es } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { PriceHike, RecurringRow } from "@/app/(app)/recurring/queries";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecurringCalendarGridProps {
  rows: RecurringRow[];
  excludedIds: Set<number>;
  isCalculatorOpen: boolean;
  onToggleExcluded?: (id: number) => void;
  /** Injected for tests — defaults to new Date() */
  today?: Date;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_NAMES = ["DOM", "LUN", "MAR", "MIÉ", "JUE", "VIE", "SÁB"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function absCents(cents: bigint): bigint {
  return cents < BigInt(0) ? -cents : cents;
}

function PriceHikeBadge({ hike }: { hike: PriceHike }) {
  const absOld = absCents(hike.oldAmountCents);
  const absNew = absCents(hike.newAmountCents);
  const pctStr = Math.round(hike.deltaPct).toString();
  const sinceStr = hike.sinceDate.toLocaleDateString("es-CO", {
    month: "short",
    day: "numeric",
  });
  const tooltipText = `era ${formatMoney(absOld, hike.currency)} → ahora ${formatMoney(absNew, hike.currency)}, desde ${sinceStr}`;

  return (
    <Badge
      variant="outline"
      className="text-destructive border-destructive/40 text-xs tabular-nums"
      title={tooltipText}
    >
      ↑ +{pctStr}%
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// SubDetail popover content
// ---------------------------------------------------------------------------

function SubDetailContent({ row }: { row: RecurringRow }) {
  const absDisplayCents = absCents(row.displayAmount.cents);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <p className="leading-snug font-medium">{row.label}</p>
        {row.priceHike && <PriceHikeBadge hike={row.priceHike} />}
      </div>

      <div className="text-muted-foreground flex flex-col gap-1 text-xs">
        <p className="text-foreground text-sm font-semibold tabular-nums">
          {row.amountType === "variable" ? "~" : ""}
          {formatMoney(absDisplayCents, row.displayAmount.currency as "COP" | "USD")}
        </p>

        <p>{row.accountLabel}</p>

        {row.categoryName && <p>{row.categoryName}</p>}

        <p>Próximo: {row.nextOccurrence}</p>

        {row.notes && <p className="italic">{row.notes}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pill component — single subscription pill inside a day cell
// ---------------------------------------------------------------------------

interface PillProps {
  row: RecurringRow;
  isCalculatorOpen: boolean;
  isExcluded: boolean;
  onToggle?: (id: number) => void;
}

function Pill({ row, isCalculatorOpen, isExcluded, onToggle }: PillProps) {
  const pillClass = cn(
    "bg-emerald-500/20 text-emerald-700 dark:bg-emerald-500/30 dark:text-emerald-300",
    "rounded-md px-1.5 py-0.5 text-xs truncate w-full text-left",
    "transition-opacity",
    isCalculatorOpen && isExcluded && "opacity-50 line-through",
  );

  if (isCalculatorOpen) {
    // In calculator mode: clicking toggles exclusion, no popover.
    return (
      <button
        type="button"
        className={pillClass}
        onClick={() => onToggle?.(row.id)}
        data-testid="sub-pill"
        data-excluded={isExcluded ? "true" : "false"}
        aria-label={`${isExcluded ? "Incluir" : "Excluir"} ${row.label}`}
        title={row.label}
      >
        {row.label}
      </button>
    );
  }

  // Normal mode: click opens detail popover.
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={pillClass}
          data-testid="sub-pill"
          aria-label={`Ver detalle: ${row.label}`}
          title={row.label}
        >
          {row.label}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-64">
        <SubDetailContent row={row} />
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// OverflowChip — "+N más" chip that shows all subs for the day in a popover
// ---------------------------------------------------------------------------

interface OverflowChipProps {
  rows: RecurringRow[];
  isCalculatorOpen: boolean;
  onToggle?: (id: number) => void;
}

function OverflowChip({ rows, isCalculatorOpen, onToggle }: OverflowChipProps) {
  const count = rows.length;

  const chipClass =
    "bg-muted text-muted-foreground rounded-md px-1.5 py-0.5 text-xs w-full text-left";

  if (isCalculatorOpen) {
    // In calculator mode: show a simple "more" indicator — each pill is already visible above.
    // We still render the overflow chip to toggle them all.
    return (
      <button
        type="button"
        className={chipClass}
        data-testid="overflow-chip"
        onClick={() => {
          for (const row of rows) {
            onToggle?.(row.id);
          }
        }}
        title={`Alternar ${count} más`}
      >
        +{count} más
      </button>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={chipClass}
          data-testid="overflow-chip"
          aria-label={`Ver ${count} recurrentes más`}
        >
          +{count} más
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-64">
        <div className="flex flex-col gap-3" data-testid="overflow-popover-content">
          {rows.map((row) => (
            <div key={row.id} className="flex flex-col gap-1 border-b pb-2 last:border-0 last:pb-0">
              <SubDetailContent row={row} />
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// DayCell
// ---------------------------------------------------------------------------

const MAX_PILLS = 2;

interface DayCellProps {
  date: Date;
  today: Date;
  inMonth: boolean;
  subs: RecurringRow[];
  isCalculatorOpen: boolean;
  excludedIds: Set<number>;
  onToggle?: (id: number) => void;
}

function DayCell({
  date,
  today,
  inMonth,
  subs,
  isCalculatorOpen,
  excludedIds,
  onToggle,
}: DayCellProps) {
  const isToday = isSameDay(date, today);
  const dayNum = getDate(date);

  return (
    <div
      className={cn(
        "border-border/50 flex min-h-[100px] flex-col gap-0.5 border p-1",
        !inMonth && "opacity-40",
      )}
      data-testid={inMonth ? `day-cell-${dayNum}` : undefined}
    >
      {/* Day number */}
      <div className="mb-0.5 flex items-center justify-start">
        <span
          className={cn(
            "flex h-6 w-6 items-center justify-center text-xs font-medium",
            isToday && "bg-primary text-primary-foreground rounded-full",
            !isToday && "text-muted-foreground",
          )}
          data-testid={isToday ? "today-marker" : undefined}
        >
          {dayNum}
        </span>
      </div>

      {/* Pills — only for in-month days */}
      {inMonth && subs.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {subs.slice(0, MAX_PILLS).map((row) => (
            <Pill
              key={row.id}
              row={row}
              isCalculatorOpen={isCalculatorOpen}
              isExcluded={excludedIds.has(row.id)}
              onToggle={onToggle}
            />
          ))}
          {subs.length > MAX_PILLS && (
            <OverflowChip
              rows={subs.slice(MAX_PILLS)}
              isCalculatorOpen={isCalculatorOpen}
              onToggle={onToggle}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main grid component
// ---------------------------------------------------------------------------

export function RecurringCalendarGrid({
  rows,
  excludedIds,
  isCalculatorOpen,
  onToggleExcluded,
  today: todayProp,
}: RecurringCalendarGridProps) {
  // Stable today reference — avoids re-creating on every render when todayProp is undefined.
  const today = useMemo(() => todayProp ?? new Date(), [todayProp]);

  // Build the grid days: start of week containing start-of-month → end of week containing end-of-month.
  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(today), { weekStartsOn: 0 });
    const end = endOfWeek(endOfMonth(today), { weekStartsOn: 0 });
    return eachDayOfInterval({ start, end });
  }, [today]);

  // Build subsByDay: ALL rows (exclusions only affect visual state, not grid presence).
  const subsByDay = useMemo(() => {
    const map = new Map<number, RecurringRow[]>();
    for (const row of rows) {
      const list = map.get(row.dayOfMonth) ?? [];
      list.push(row);
      map.set(row.dayOfMonth, list);
    }
    return map;
  }, [rows]);

  // Month title: "Mayo 2026" (capitalize first letter).
  const monthTitle = useMemo(() => {
    const raw = format(today, "LLLL yyyy", { locale: es });
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }, [today]);

  return (
    <div className="flex flex-col gap-2" data-testid="recurring-calendar-grid">
      {/* Month title */}
      <p className="text-foreground text-sm font-semibold">{monthTitle}</p>

      {/* Day-of-week header */}
      <div className="grid grid-cols-7 gap-0">
        {DAY_NAMES.map((name) => (
          <div
            key={name}
            className="text-muted-foreground py-1 text-center text-[10px] font-medium tracking-wide uppercase"
          >
            {name}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7 gap-0" data-testid="calendar-grid">
        {days.map((date) => {
          const inMonth = isSameMonth(date, today);
          const dayNum = getDate(date);
          const subs = inMonth ? (subsByDay.get(dayNum) ?? []) : [];

          return (
            <DayCell
              key={date.toISOString()}
              date={date}
              today={today}
              inMonth={inMonth}
              subs={subs}
              isCalculatorOpen={isCalculatorOpen}
              excludedIds={excludedIds}
              onToggle={onToggleExcluded}
            />
          );
        })}
      </div>
    </div>
  );
}
