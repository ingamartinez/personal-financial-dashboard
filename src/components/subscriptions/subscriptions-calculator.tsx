"use client";

import { useState } from "react";
import { Calculator, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { formatMoney } from "@/lib/money";
import type { AggregationBucket } from "@/lib/fx/aggregate";
import type { PriceHike, SubscriptionRow } from "@/app/(app)/subscriptions/queries";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SubscriptionsCalculatorProps {
  rows: SubscriptionRow[];
  monthlyTotals: AggregationBucket[];
  annualTotals: AggregationBucket[];
}

// ---------------------------------------------------------------------------
// Math helpers (pure, no server imports)
// ---------------------------------------------------------------------------

/**
 * Sum `displayAmount.cents` from the given rows, grouped by display currency.
 * Mirrors what `sumByDisplayCurrency` does on the server but using the
 * already-computed per-row displayAmount so we don't pull pino into the
 * client bundle.
 */
function sumDisplayAmounts(rows: SubscriptionRow[]): Map<string, bigint> {
  const buckets = new Map<string, bigint>();
  for (const row of rows) {
    const cur = row.displayAmount.currency;
    buckets.set(cur, (buckets.get(cur) ?? BigInt(0)) + row.displayAmount.cents);
  }
  return buckets;
}

/**
 * Given the base total buckets and the excluded rows, compute:
 * - remainingTotals: buckets after removing excluded
 * - savingsBuckets: buckets of the excluded subset (sign-preserved)
 */
function computeCalculatorTotals(
  monthlyTotals: AggregationBucket[],
  annualTotals: AggregationBucket[],
  rows: SubscriptionRow[],
  excludedIds: Set<number>,
): {
  remainingMonthly: AggregationBucket[];
  remainingAnnual: AggregationBucket[];
  savingsMonthly: AggregationBucket[];
  savingsAnnual: AggregationBucket[];
} {
  const excludedRows = rows.filter((r) => excludedIds.has(r.id));

  // Monthly savings = sum of displayAmount for excluded rows (grouped by currency).
  const excludedMonthlyMap = sumDisplayAmounts(excludedRows);
  // Annual savings = excluded monthly × 12.
  const excludedAnnualMap = new Map<string, bigint>();
  for (const [cur, cents] of excludedMonthlyMap) {
    excludedAnnualMap.set(cur, cents * BigInt(12));
  }

  // Build remaining monthly buckets by subtracting from base totals.
  const remainingMonthly: AggregationBucket[] = monthlyTotals.map((bucket) => ({
    ...bucket,
    cents: bucket.cents - (excludedMonthlyMap.get(bucket.currency) ?? BigInt(0)),
  }));

  const remainingAnnual: AggregationBucket[] = annualTotals.map((bucket) => ({
    ...bucket,
    cents: bucket.cents - (excludedAnnualMap.get(bucket.currency) ?? BigInt(0)),
  }));

  // Savings buckets: only currencies that appear in the exclusion.
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
// Helper: format absolute bucket cents
// ---------------------------------------------------------------------------

function absCents(cents: bigint): bigint {
  return cents < BigInt(0) ? -cents : cents;
}

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
// Sub-components
// ---------------------------------------------------------------------------

function TotalsHeader({
  monthlyTotals,
  annualTotals,
}: {
  monthlyTotals: AggregationBucket[];
  annualTotals: AggregationBucket[];
}) {
  if (monthlyTotals.length === 0) return null;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {monthlyTotals.map((bucket) => {
        const annual = annualTotals.find((b) => b.currency === bucket.currency);
        return (
          <Card key={bucket.currency} size="sm">
            <CardContent className="flex flex-col gap-0.5 py-3">
              <p className="text-muted-foreground text-xs">Mensual</p>
              <p className="font-heading text-base font-medium tabular-nums">
                {formatMoney(absCents(bucket.cents), bucket.currency as "COP" | "USD")}
              </p>
              {annual && (
                <p className="text-muted-foreground text-xs tabular-nums">
                  {formatMoney(absCents(annual.cents), annual.currency as "COP" | "USD")} / año
                </p>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

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

function PriceHikeBadge({ hike }: { hike: PriceHike }) {
  const absOld = hike.oldAmountCents < BigInt(0) ? -hike.oldAmountCents : hike.oldAmountCents;
  const absNew = hike.newAmountCents < BigInt(0) ? -hike.newAmountCents : hike.newAmountCents;
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

function SubscriptionCardCalculator({
  row,
  showCheckbox,
  checked,
  onToggle,
}: {
  row: SubscriptionRow;
  showCheckbox: boolean;
  checked: boolean;
  onToggle: (id: number) => void;
}) {
  const absDisplayCents =
    row.displayAmount.cents < BigInt(0) ? -row.displayAmount.cents : row.displayAmount.cents;
  const absNativeCents = row.amountCents < BigInt(0) ? -row.amountCents : row.amountCents;
  const showNative = row.displayAmount.converted && row.displayAmount.currency !== row.currency;
  const muted = showCheckbox && !checked;

  return (
    <div className={muted ? "opacity-50" : undefined}>
      <Card size="sm">
        <CardContent className="flex flex-col gap-1.5 py-3">
          {/* Row: checkbox (optional) + label + badges + amount */}
          <div className="flex items-start gap-2">
            {showCheckbox && (
              <Checkbox
                checked={checked}
                onCheckedChange={() => onToggle(row.id)}
                className="mt-0.5 shrink-0"
                aria-label={`Incluir ${row.label}`}
              />
            )}

            <div className="flex min-w-0 flex-1 items-start justify-between gap-2">
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="leading-snug font-medium">{row.label}</span>
                  {row.amountType === "variable" && (
                    <Badge variant="outline" className="text-xs">
                      variable
                    </Badge>
                  )}
                </div>
                <p className="text-muted-foreground truncate text-xs">{row.accountLabel}</p>
                {row.categoryName && (
                  <p className="text-muted-foreground text-xs">{row.categoryName}</p>
                )}
              </div>

              {/* Amount block */}
              <div className="flex shrink-0 flex-col items-end gap-0.5">
                <p className={`font-heading tabular-nums${muted ? "line-through" : ""}`}>
                  {row.amountType === "variable" ? "~" : ""}
                  {formatMoney(absDisplayCents, row.displayAmount.currency as "COP" | "USD")}
                </p>
                {row.priceHike && <PriceHikeBadge hike={row.priceHike} />}
                {showNative && (
                  <p className="text-muted-foreground text-xs tabular-nums">
                    ({formatMoney(absNativeCents, row.currency as "COP" | "USD")})
                  </p>
                )}
                <p className="text-muted-foreground text-xs tabular-nums">
                  {formatMoney(
                    row.annualCents < BigInt(0) ? -row.annualCents : row.annualCents,
                    row.currency as "COP" | "USD",
                  )}{" "}
                  / año
                </p>
              </div>
            </div>
          </div>

          {/* Row: next occurrence + day */}
          <div
            className={`text-muted-foreground flex items-center gap-2 text-xs${showCheckbox ? "pl-6" : ""}`}
          >
            <span>Próxima: {row.nextOccurrence}</span>
            <span>·</span>
            <span>Día {row.dayOfMonth}</span>
            {row.skippedMonths.length > 0 && (
              <>
                <span>·</span>
                <Badge variant="secondary" className="text-xs">
                  {row.skippedMonths.length} omisión{row.skippedMonths.length > 1 ? "es" : ""}
                </Badge>
              </>
            )}
          </div>

          {row.notes && (
            <p className={`text-muted-foreground text-xs italic${showCheckbox ? "pl-6" : ""}`}>
              {row.notes}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SubscriptionsCalculator({
  rows,
  monthlyTotals,
  annualTotals,
}: SubscriptionsCalculatorProps) {
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

  const { remainingMonthly, remainingAnnual, savingsMonthly, savingsAnnual } =
    computeCalculatorTotals(monthlyTotals, annualTotals, rows, excludedIds);

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-muted-foreground text-sm">
            No hay suscripciones activas. Agregálas en{" "}
            <a href="/settings/recurring" className="underline underline-offset-4">
              Settings → Recurring
            </a>{" "}
            con la categoría <strong>suscripciones</strong>.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header bar: totals (when closed) or calculator header (when open) */}
      {isOpen ? (
        <CalculatorHeader
          monthlyTotals={monthlyTotals}
          annualTotals={annualTotals}
          remainingMonthly={remainingMonthly}
          remainingAnnual={remainingAnnual}
          savingsMonthly={savingsMonthly}
          savingsAnnual={savingsAnnual}
          excludedCount={excludedCount}
        />
      ) : (
        <TotalsHeader monthlyTotals={monthlyTotals} annualTotals={annualTotals} />
      )}

      {/* Action bar: calculator toggle + mark-all */}
      <div className="flex items-center gap-2">
        {isOpen ? (
          <>
            <Button variant="outline" size="sm" onClick={handleClose}>
              <X className="mr-1.5 size-4" />
              Cerrar calculadora
            </Button>
            {hasExcluded && (
              <Button variant="ghost" size="sm" onClick={handleMarkAll}>
                Marcar todas
              </Button>
            )}
          </>
        ) : (
          <Button variant="outline" size="sm" onClick={handleOpen}>
            <Calculator className="mr-1.5 size-4" />
            Calculadora
          </Button>
        )}
      </div>

      {/* Subscription rows */}
      <div className="flex flex-col gap-2">
        {rows.map((row) => (
          <SubscriptionCardCalculator
            key={row.id}
            row={row}
            showCheckbox={isOpen}
            checked={!excludedIds.has(row.id)}
            onToggle={handleToggle}
          />
        ))}
      </div>
    </div>
  );
}
