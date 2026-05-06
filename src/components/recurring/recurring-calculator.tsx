"use client";

import { useState } from "react";
import { Calculator, CheckCircle2, Circle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatMoney } from "@/lib/money";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { RecurringCalendarGrid } from "./recurring-calendar-grid";
import { RecurringList } from "./recurring-list";
import { UpcomingCharges } from "./upcoming-charges";
import type { AggregationBucket } from "@/lib/fx/aggregate";
import type { RecurringRow } from "@/app/(app)/recurring/queries";
import type { UpcomingStatus } from "@/lib/recurring/upcoming";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RecurringCalculatorProps {
  rows: RecurringRow[];
  monthlyTotals: AggregationBucket[];
  annualTotals: AggregationBucket[];
  slotStatusByRecurringId?: Record<number, UpcomingStatus>;
}

// ---------------------------------------------------------------------------
// Math helpers (pure, no server imports)
// ---------------------------------------------------------------------------

/**
 * Sum `displayAmount.cents` from the given rows, grouped by display currency.
 */
function sumDisplayAmounts(rows: RecurringRow[]): Map<string, bigint> {
  const buckets = new Map<string, bigint>();
  for (const row of rows) {
    const cur = row.displayAmount.currency;
    buckets.set(cur, (buckets.get(cur) ?? BigInt(0)) + row.displayAmount.cents);
  }
  return buckets;
}

function absCents(cents: bigint): bigint {
  return cents < BigInt(0) ? -cents : cents;
}

/**
 * Given the base total buckets and the excluded rows, compute:
 * - remainingTotals: buckets after removing excluded
 * - savingsBuckets: buckets of the excluded subset (sign-preserved)
 */
function computeCalculatorTotals(
  monthlyTotals: AggregationBucket[],
  annualTotals: AggregationBucket[],
  rows: RecurringRow[],
  excludedIds: Set<number>,
): {
  remainingMonthly: AggregationBucket[];
  remainingAnnual: AggregationBucket[];
  savingsMonthly: AggregationBucket[];
  savingsAnnual: AggregationBucket[];
} {
  const excludedRows = rows.filter((r) => excludedIds.has(r.id));

  const excludedMonthlyMap = sumDisplayAmounts(excludedRows);
  const excludedAnnualMap = new Map<string, bigint>();
  for (const [cur, cents] of excludedMonthlyMap) {
    excludedAnnualMap.set(cur, cents * BigInt(12));
  }

  const remainingMonthly: AggregationBucket[] = monthlyTotals.map((bucket) => ({
    ...bucket,
    cents: bucket.cents - (excludedMonthlyMap.get(bucket.currency) ?? BigInt(0)),
  }));

  const remainingAnnual: AggregationBucket[] = annualTotals.map((bucket) => ({
    ...bucket,
    cents: bucket.cents - (excludedAnnualMap.get(bucket.currency) ?? BigInt(0)),
  }));

  const savingsMonthly: AggregationBucket[] = [];
  for (const [cur, cents] of excludedMonthlyMap) {
    const base = monthlyTotals.find((b) => b.currency === cur);
    savingsMonthly.push({
      currency: cur as AggregationBucket["currency"],
      cents,
      txCount: excludedRows.filter((r) => r.displayAmount.currency === cur).length,
      missingTrmCount: base?.missingTrmCount ?? 0,
      convertedCount: base?.convertedCount ?? 0,
    });
  }

  const savingsAnnual: AggregationBucket[] = [];
  for (const [cur, cents] of excludedAnnualMap) {
    savingsAnnual.push({
      currency: cur as AggregationBucket["currency"],
      cents,
      txCount: excludedRows.filter((r) => r.displayAmount.currency === cur).length,
      missingTrmCount: 0,
      convertedCount: 0,
    });
  }

  return { remainingMonthly, remainingAnnual, savingsMonthly, savingsAnnual };
}

// ---------------------------------------------------------------------------
// BucketLabel helper
// ---------------------------------------------------------------------------

function BucketLabel({
  monthly,
  annual,
}: {
  monthly: AggregationBucket[];
  annual: AggregationBucket[];
}) {
  return (
    <>
      {monthly.map((bucket) => {
        const ann = annual.find((b) => b.currency === bucket.currency);
        return (
          <span key={bucket.currency} className="tabular-nums">
            {formatMoney(absCents(bucket.cents), bucket.currency as "COP" | "USD")} / mes
            {ann && (
              <>
                {" · "}
                {formatMoney(absCents(ann.cents), ann.currency as "COP" | "USD")} / año
              </>
            )}
          </span>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// MonthLegend — "○ $X (N) te falta · ✓ $Y (M) pagado"
// ---------------------------------------------------------------------------

interface MonthLegendProps {
  rows: RecurringRow[];
  slotStatusByRecurringId: Record<number, UpcomingStatus>;
}

function MonthLegend({ rows, slotStatusByRecurringId }: MonthLegendProps) {
  let pendingCents = BigInt(0);
  let pendingCount = 0;
  let paidCents = BigInt(0);
  let paidCount = 0;
  let mixedCurrency = false;
  let currency: string | null = null;

  for (const row of rows) {
    const status = slotStatusByRecurringId[row.id];
    if (!status) continue;

    const cents =
      row.displayAmount.cents < BigInt(0) ? -row.displayAmount.cents : row.displayAmount.cents;
    const cur = row.displayAmount.currency;

    if (currency === null) {
      currency = cur;
    } else if (currency !== cur) {
      mixedCurrency = true;
    }

    if (status === "upcoming" || status === "overdue") {
      pendingCents += cents;
      pendingCount++;
    } else if (status === "matched") {
      paidCents += cents;
      paidCount++;
    } else if (status === "dismissed") {
      continue;
    }
  }

  if (pendingCount === 0 && paidCount === 0) return null;

  const cur = mixedCurrency || currency === null ? null : (currency as "COP" | "USD");

  return (
    <p className="text-muted-foreground text-sm" data-testid="month-legend">
      {pendingCount > 0 && (
        <span className="inline-flex items-center gap-1">
          <Circle className="size-3.5 shrink-0 text-sky-500" aria-hidden="true" />
          {cur ? formatMoney(pendingCents, cur) : null}{" "}
          <span className="text-xs">({pendingCount}) te falta</span>
        </span>
      )}
      {pendingCount > 0 && paidCount > 0 && <span className="mx-1.5 text-xs">·</span>}
      {paidCount > 0 && (
        <span className="inline-flex items-center gap-1">
          <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
          {cur ? formatMoney(paidCents, cur) : null}{" "}
          <span className="text-xs">({paidCount}) pagado</span>
        </span>
      )}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Totals header — shows total + próximo cobro
// ---------------------------------------------------------------------------

function TotalsCard({
  monthlyTotals,
  annualTotals,
  rows,
  excludedIds,
  isCalculatorOpen,
  onOpenCalculator,
  slotStatusByRecurringId,
}: {
  monthlyTotals: AggregationBucket[];
  annualTotals: AggregationBucket[];
  rows: RecurringRow[];
  excludedIds: Set<number>;
  isCalculatorOpen: boolean;
  onOpenCalculator: () => void;
  slotStatusByRecurringId?: Record<number, UpcomingStatus>;
}) {
  // Compute earliest nextOccurrence among non-excluded rows.
  const activeRows = rows.filter((r) => !excludedIds.has(r.id));
  const earliest = activeRows.reduce<RecurringRow | null>((acc, r) => {
    if (!acc || r.nextOccurrence < acc.nextOccurrence) return r;
    return acc;
  }, null);

  const proximoCobro = earliest
    ? (() => {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const nextDate = new Date(earliest.nextOccurrence + "T00:00:00");
        const diffDays = Math.round((nextDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        const daysLabel =
          diffDays === 0 ? "hoy" : diffDays === 1 ? "mañana" : `en ${diffDays} días`;
        return `${earliest.label} — ${daysLabel}`;
      })()
    : null;

  const primaryBucket = monthlyTotals[0];
  const primaryAnnual = annualTotals[0];

  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-4 py-4">
        <div className="flex flex-col gap-1">
          {primaryBucket && (
            <p className="font-heading text-xl font-semibold tabular-nums">
              {formatMoney(absCents(primaryBucket.cents), primaryBucket.currency as "COP" | "USD")}{" "}
              / mes
              {primaryAnnual && (
                <span className="text-muted-foreground ml-2 text-sm font-normal">
                  ·{" "}
                  {formatMoney(
                    absCents(primaryAnnual.cents),
                    primaryAnnual.currency as "COP" | "USD",
                  )}{" "}
                  / año
                </span>
              )}
            </p>
          )}
          {proximoCobro && (
            <p className="text-muted-foreground text-sm">
              Próximo cobro: <span className="text-foreground">{proximoCobro}</span>
            </p>
          )}
          {slotStatusByRecurringId && Object.keys(slotStatusByRecurringId).length > 0 && (
            <MonthLegend rows={activeRows} slotStatusByRecurringId={slotStatusByRecurringId} />
          )}
        </div>
        {!isCalculatorOpen && (
          <Button variant="outline" size="sm" onClick={onOpenCalculator} className="shrink-0">
            <Calculator className="mr-1.5 size-4" />
            Calculadora
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Calculator savings header (shown when calculator is open)
// ---------------------------------------------------------------------------

function CalculatorHeader({
  monthlyTotals,
  annualTotals,
  remainingMonthly,
  remainingAnnual,
  savingsMonthly,
  savingsAnnual,
  excludedCount,
}: {
  monthlyTotals: AggregationBucket[];
  annualTotals: AggregationBucket[];
  remainingMonthly: AggregationBucket[];
  remainingAnnual: AggregationBucket[];
  savingsMonthly: AggregationBucket[];
  savingsAnnual: AggregationBucket[];
  excludedCount: number;
}) {
  const hasExcluded = excludedCount > 0;

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border p-4">
      <p className="text-sm">
        <span className="text-muted-foreground">Total actual: </span>
        <BucketLabel monthly={monthlyTotals} annual={annualTotals} />
      </p>

      {hasExcluded && (
        <>
          <p className="text-sm">
            <span className="text-muted-foreground">
              Si cancelás {excludedCount} desmarcada{excludedCount !== 1 ? "s" : ""}:{" "}
            </span>
            <BucketLabel monthly={remainingMonthly} annual={remainingAnnual} />
          </p>
          <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
            Ahorrarías: <BucketLabel monthly={savingsMonthly} annual={savingsAnnual} />
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main orchestrator component
// ---------------------------------------------------------------------------

export function RecurringCalculator({
  rows,
  monthlyTotals,
  annualTotals,
  slotStatusByRecurringId,
}: RecurringCalculatorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [excludedIds, setExcludedIds] = useState<Set<number>>(new Set());

  function handleToggle(id: number) {
    setExcludedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function handleMarkAll() {
    setExcludedIds(new Set());
  }

  function handleOpen() {
    setExcludedIds(new Set());
    setIsOpen(true);
  }

  function handleClose() {
    setIsOpen(false);
    setExcludedIds(new Set());
  }

  const excludedCount = excludedIds.size;
  const hasExcluded = excludedCount > 0;

  // Calculator totals (only used when calculator is open).
  const { remainingMonthly, remainingAnnual, savingsMonthly, savingsAnnual } =
    computeCalculatorTotals(monthlyTotals, annualTotals, rows, excludedIds);

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-muted-foreground text-sm">
            No hay gastos fijos activos. Agregálos en{" "}
            <a href="/settings/recurring" className="underline underline-offset-4">
              Settings → Recurring
            </a>
            .
          </p>
        </CardContent>
      </Card>
    );
  }

  // Compute display totals from active rows for the totals card.
  const activeMonthlyTotals: AggregationBucket[] = monthlyTotals.map((bucket) => ({
    ...bucket,
    cents:
      bucket.cents -
      rows
        .filter((r) => excludedIds.has(r.id) && r.displayAmount.currency === bucket.currency)
        .reduce((acc, r) => acc + r.displayAmount.cents, BigInt(0)),
  }));
  const activeAnnualTotals: AggregationBucket[] = annualTotals.map((bucket) => ({
    ...bucket,
    cents:
      bucket.cents -
      rows
        .filter((r) => excludedIds.has(r.id) && r.displayAmount.currency === bucket.currency)
        .reduce((acc, r) => acc + r.displayAmount.cents * BigInt(12), BigInt(0)),
  }));

  return (
    <div className="flex flex-col gap-4">
      {/* Totals header (always visible) */}
      <TotalsCard
        monthlyTotals={isOpen ? activeMonthlyTotals : monthlyTotals}
        annualTotals={isOpen ? activeAnnualTotals : annualTotals}
        rows={rows}
        excludedIds={excludedIds}
        isCalculatorOpen={isOpen}
        onOpenCalculator={handleOpen}
        slotStatusByRecurringId={slotStatusByRecurringId}
      />

      {/* Calculator header + action bar (when open) */}
      {isOpen && (
        <>
          <CalculatorHeader
            monthlyTotals={monthlyTotals}
            annualTotals={annualTotals}
            remainingMonthly={remainingMonthly}
            remainingAnnual={remainingAnnual}
            savingsMonthly={savingsMonthly}
            savingsAnnual={savingsAnnual}
            excludedCount={excludedCount}
          />
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleClose}>
              <X className="mr-1.5 size-4" />
              Cerrar calculadora
            </Button>
            {hasExcluded && (
              <Button variant="ghost" size="sm" onClick={handleMarkAll}>
                Marcar todas
              </Button>
            )}
          </div>
        </>
      )}

      {/* Accordion: Lista compacta (closed) + Calendario (open) */}
      <Accordion type="multiple" defaultValue={["calendar"]} className="flex flex-col gap-0">
        <AccordionItem value="list" className="rounded-lg border px-3">
          <AccordionTrigger className="text-sm font-semibold">
            Lista compacta
            {isOpen && (
              <span className="text-muted-foreground ml-2 text-xs font-normal">
                — tocá para excluir
              </span>
            )}
          </AccordionTrigger>
          <AccordionContent>
            <RecurringList
              rows={rows}
              excludedIds={excludedIds}
              isCalculatorOpen={isOpen}
              slotStatusById={slotStatusByRecurringId}
              onToggleExcluded={handleToggle}
            />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="calendar" className="mt-2 rounded-lg border px-3">
          <AccordionTrigger className="text-sm font-semibold">Calendario</AccordionTrigger>
          <AccordionContent>
            <RecurringCalendarGrid rows={rows} slotStatusById={slotStatusByRecurringId} />
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      {/* Próximos 7 días callout */}
      <UpcomingCharges
        rows={rows}
        excludedIds={excludedIds}
        slotStatusById={slotStatusByRecurringId}
      />
    </div>
  );
}
