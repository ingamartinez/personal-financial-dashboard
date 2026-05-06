"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { PriceHike, RecurringRow } from "@/app/(app)/recurring/queries";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function absCents(cents: bigint): bigint {
  return cents < BigInt(0) ? -cents : cents;
}

// ---------------------------------------------------------------------------
// Shared SubDetailContent — reused from calendar grid
// ---------------------------------------------------------------------------

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
    <span className="text-destructive text-xs tabular-nums" title={tooltipText}>
      ↑ +{pctStr}%
    </span>
  );
}

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
// Compact pill — one recurring per pill in the dense grid
// ---------------------------------------------------------------------------

interface CompactPillProps {
  row: RecurringRow;
  isCalculatorOpen: boolean;
  isExcluded: boolean;
  onToggle?: (id: number) => void;
}

function CompactPill({ row, isCalculatorOpen, isExcluded, onToggle }: CompactPillProps) {
  const absDisplayCents = absCents(row.displayAmount.cents);
  const amountStr = formatMoney(absDisplayCents, row.displayAmount.currency as "COP" | "USD");

  const pillClass = cn(
    "flex flex-col gap-0.5 rounded-md border px-2 py-1.5 text-left w-full",
    "transition-opacity cursor-pointer",
    "hover:bg-accent",
    isCalculatorOpen && isExcluded && "opacity-50",
  );

  const label = (
    <>
      <div className="flex items-baseline gap-1.5">
        <span className="text-muted-foreground w-5 shrink-0 text-right text-[11px] font-semibold tabular-nums">
          {row.dayOfMonth}
        </span>
        <span
          className={cn(
            "truncate text-xs leading-tight font-medium",
            isCalculatorOpen && isExcluded && "line-through",
          )}
        >
          {row.label}
        </span>
      </div>
      <span className="text-muted-foreground pl-6 text-[11px] tabular-nums">{amountStr}</span>
    </>
  );

  if (isCalculatorOpen) {
    return (
      <button
        type="button"
        className={pillClass}
        onClick={() => onToggle?.(row.id)}
        data-testid="recurring-list-pill"
        data-excluded={isExcluded ? "true" : "false"}
        aria-label={`${isExcluded ? "Incluir" : "Excluir"} ${row.label}`}
        title={`${row.label} — ${amountStr}`}
      >
        {label}
      </button>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={pillClass}
          data-testid="recurring-list-pill"
          aria-label={`Ver detalle: ${row.label}`}
          title={`${row.label} — ${amountStr}`}
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-64">
        <SubDetailContent row={row} />
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// RecurringList — compact pill grid, sorted by dayOfMonth asc (from caller)
// ---------------------------------------------------------------------------

export interface RecurringListProps {
  rows: RecurringRow[];
  excludedIds: Set<number>;
  isCalculatorOpen: boolean;
  onToggleExcluded?: (id: number) => void;
}

export function RecurringList({
  rows,
  excludedIds,
  isCalculatorOpen,
  onToggleExcluded,
}: RecurringListProps) {
  if (rows.length === 0) return null;

  return (
    <div
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"
      data-testid="recurring-list"
    >
      {rows.map((row) => (
        <CompactPill
          key={row.id}
          row={row}
          isCalculatorOpen={isCalculatorOpen}
          isExcluded={excludedIds.has(row.id)}
          onToggle={onToggleExcluded}
        />
      ))}
    </div>
  );
}
