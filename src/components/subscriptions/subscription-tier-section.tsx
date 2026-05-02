"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { formatMoney } from "@/lib/money";
import type { PriceHike, SubscriptionRow } from "@/app/(app)/subscriptions/queries";
import type { TierName } from "@/lib/subscriptions/tiers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SubscriptionTierSectionProps {
  tier: TierName;
  rows: SubscriptionRow[];
  subtotal: bigint;
  pct: number;
  calculatorEnabled: boolean;
  excludedIds: Set<number>;
  onToggleExcluded?: (id: number) => void;
}

// ---------------------------------------------------------------------------
// Shared helpers
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
// Tier labels
// ---------------------------------------------------------------------------

const TIER_LABELS: Record<TierName, string> = {
  top: "Top spend",
  medianas: "Medianas",
  pequeñas: "Pequeñas",
};

// ---------------------------------------------------------------------------
// Top-tier card (full-width, large typography)
// ---------------------------------------------------------------------------

function TopCard({
  row,
  calculatorEnabled,
  isExcluded,
  onToggle,
}: {
  row: SubscriptionRow;
  calculatorEnabled: boolean;
  isExcluded: boolean;
  onToggle?: (id: number) => void;
}) {
  const absDisplayCents = absCents(row.displayAmount.cents);
  const absNativeCents = absCents(row.amountCents);
  const showNative = row.displayAmount.converted && row.displayAmount.currency !== row.currency;
  const muted = calculatorEnabled && isExcluded;

  return (
    <div className={muted ? "opacity-50" : undefined}>
      <Card>
        <CardContent className="flex flex-col gap-2 pt-4 pb-4">
          <div className="flex items-start gap-3">
            {calculatorEnabled && (
              <Checkbox
                checked={!isExcluded}
                onCheckedChange={() => onToggle?.(row.id)}
                className="mt-1 shrink-0"
                aria-label={`Incluir ${row.label}`}
              />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-lg leading-snug font-semibold">{row.label}</span>
                {row.amountType === "variable" && (
                  <Badge variant="outline" className="text-xs">
                    variable
                  </Badge>
                )}
                {row.skippedMonths.length > 0 && (
                  <Badge variant="secondary" className="text-xs">
                    {row.skippedMonths.length} omisión{row.skippedMonths.length > 1 ? "es" : ""}
                  </Badge>
                )}
              </div>

              <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                <span>{row.accountLabel}</span>
                {row.categoryName && (
                  <>
                    <span>·</span>
                    <span>{row.categoryName}</span>
                  </>
                )}
                <span>·</span>
                <span>día {row.dayOfMonth}</span>
                <span>·</span>
                <span>Próxima: {row.nextOccurrence}</span>
              </div>

              {row.notes && <p className="text-muted-foreground text-xs italic">{row.notes}</p>}
            </div>

            {/* Amount */}
            <div className="flex shrink-0 flex-col items-end gap-0.5">
              <p className={`text-2xl font-bold tabular-nums${muted ? "line-through" : ""}`}>
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
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Medianas card (current sm layout)
// ---------------------------------------------------------------------------

function MedianasCard({
  row,
  calculatorEnabled,
  isExcluded,
  onToggle,
}: {
  row: SubscriptionRow;
  calculatorEnabled: boolean;
  isExcluded: boolean;
  onToggle?: (id: number) => void;
}) {
  const absDisplayCents = absCents(row.displayAmount.cents);
  const absNativeCents = absCents(row.amountCents);
  const showNative = row.displayAmount.converted && row.displayAmount.currency !== row.currency;
  const muted = calculatorEnabled && isExcluded;

  return (
    <div className={muted ? "opacity-50" : undefined}>
      <Card size="sm">
        <CardContent className="flex flex-col gap-1.5 py-3">
          <div className="flex items-start gap-2">
            {calculatorEnabled && (
              <Checkbox
                checked={!isExcluded}
                onCheckedChange={() => onToggle?.(row.id)}
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

          <div
            className={`text-muted-foreground flex items-center gap-2 text-xs${calculatorEnabled ? "pl-6" : ""}`}
          >
            <span>Próxima: {row.nextOccurrence}</span>
            <span>·</span>
            <span>día {row.dayOfMonth}</span>
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
            <p className={`text-muted-foreground text-xs italic${calculatorEnabled ? "pl-6" : ""}`}>
              {row.notes}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pequeñas chip (pill layout, expandable)
// ---------------------------------------------------------------------------

function PequeñasChip({
  row,
  calculatorEnabled,
  isExcluded,
  onToggle,
}: {
  row: SubscriptionRow;
  calculatorEnabled: boolean;
  isExcluded: boolean;
  onToggle?: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const absDisplayCents = absCents(row.displayAmount.cents);
  const absNativeCents = absCents(row.amountCents);
  const showNative = row.displayAmount.converted && row.displayAmount.currency !== row.currency;
  const muted = calculatorEnabled && isExcluded;

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className={`hover:bg-muted/50 flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-opacity ${
          muted ? "opacity-50" : ""
        }`}
        aria-label={`${row.label}: ${formatMoney(absDisplayCents, row.displayAmount.currency as "COP" | "USD")} — expandir`}
      >
        {calculatorEnabled && (
          <Checkbox
            checked={!isExcluded}
            onCheckedChange={() => {
              onToggle?.(row.id);
            }}
            className="size-3.5 shrink-0"
            aria-label={`Incluir ${row.label}`}
            onClick={(e) => e.stopPropagation()}
          />
        )}
        <span className={`font-medium${muted ? "line-through" : ""}`}>{row.label}</span>
        <span className="text-muted-foreground tabular-nums">
          {row.amountType === "variable" ? "~" : ""}
          {formatMoney(absDisplayCents, row.displayAmount.currency as "COP" | "USD")}
        </span>
        {row.priceHike && (
          <span className="text-destructive tabular-nums">
            ↑{Math.round(row.priceHike.deltaPct)}%
          </span>
        )}
      </button>
    );
  }

  // Expanded view
  return (
    <div className={`col-span-full ${muted ? "opacity-50" : ""}`}>
      <Card size="sm">
        <CardContent className="flex flex-col gap-1.5 py-3">
          <div className="flex items-start gap-2">
            {calculatorEnabled && (
              <Checkbox
                checked={!isExcluded}
                onCheckedChange={() => onToggle?.(row.id)}
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
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <span>Próxima: {row.nextOccurrence}</span>
            <span>·</span>
            <span>día {row.dayOfMonth}</span>
            {row.skippedMonths.length > 0 && (
              <>
                <span>·</span>
                <Badge variant="secondary" className="text-xs">
                  {row.skippedMonths.length} omisión{row.skippedMonths.length > 1 ? "es" : ""}
                </Badge>
              </>
            )}
          </div>
          {row.notes && <p className="text-muted-foreground text-xs italic">{row.notes}</p>}
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="text-muted-foreground mt-1 self-end text-xs underline underline-offset-2"
          >
            Cerrar
          </button>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SubscriptionTierSection({
  tier,
  rows,
  subtotal,
  pct,
  calculatorEnabled,
  excludedIds,
  onToggleExcluded,
}: SubscriptionTierSectionProps) {
  if (rows.length === 0) return null;

  // For multi-currency subtotals (mixed), we need to decide the currency to display.
  // Use the first row's displayAmount currency as the primary (they're typically unified
  // by displayCurrencyMode on the server).
  const displayCurrency = rows[0]?.displayAmount.currency ?? "COP";

  return (
    <div className="flex flex-col gap-2">
      {/* Section header */}
      <div className="flex items-center gap-2">
        <div className="bg-border h-px flex-1" />
        <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {TIER_LABELS[tier]}
        </span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {formatMoney(subtotal, displayCurrency as "COP" | "USD")} ({pct}%)
        </span>
        <div className="bg-border h-px flex-1" />
      </div>

      {/* Cards per tier style */}
      {tier === "top" && (
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <TopCard
              key={row.id}
              row={row}
              calculatorEnabled={calculatorEnabled}
              isExcluded={excludedIds.has(row.id)}
              onToggle={onToggleExcluded}
            />
          ))}
        </div>
      )}

      {tier === "medianas" && (
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <MedianasCard
              key={row.id}
              row={row}
              calculatorEnabled={calculatorEnabled}
              isExcluded={excludedIds.has(row.id)}
              onToggle={onToggleExcluded}
            />
          ))}
        </div>
      )}

      {tier === "pequeñas" && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
          {rows.map((row) => (
            <PequeñasChip
              key={row.id}
              row={row}
              calculatorEnabled={calculatorEnabled}
              isExcluded={excludedIds.has(row.id)}
              onToggle={onToggleExcluded}
            />
          ))}
        </div>
      )}
    </div>
  );
}
