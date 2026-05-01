import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatMoney } from "@/lib/money";
import type { AggregationBucket } from "@/lib/fx/aggregate";
import type { SubscriptionRow } from "@/app/(app)/subscriptions/queries";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SubscriptionListProps {
  rows: SubscriptionRow[];
  monthlyTotals: AggregationBucket[];
  annualTotals: AggregationBucket[];
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
        // Find the matching annual bucket (same currency).
        const annual = annualTotals.find((b) => b.currency === bucket.currency);
        return (
          <Card key={bucket.currency} size="sm">
            <CardContent className="flex flex-col gap-0.5 py-3">
              <p className="text-muted-foreground text-xs">Monthly</p>
              <p className="font-heading text-base font-medium tabular-nums">
                {formatMoney(
                  bucket.cents < BigInt(0) ? -bucket.cents : bucket.cents,
                  bucket.currency as "COP" | "USD",
                )}
              </p>
              {annual && (
                <p className="text-muted-foreground text-xs tabular-nums">
                  {formatMoney(
                    annual.cents < BigInt(0) ? -annual.cents : annual.cents,
                    annual.currency as "COP" | "USD",
                  )}{" "}
                  / year
                </p>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function SubscriptionCard({ row }: { row: SubscriptionRow }) {
  const absDisplayCents =
    row.displayAmount.cents < BigInt(0) ? -row.displayAmount.cents : row.displayAmount.cents;

  const absNativeCents = row.amountCents < BigInt(0) ? -row.amountCents : row.amountCents;

  // Show native amount when it differs from display (cross-currency conversion applied).
  const showNative = row.displayAmount.converted && row.displayAmount.currency !== row.currency;

  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-1.5 py-3">
        {/* Row: label + badges + amount */}
        <div className="flex items-start justify-between gap-2">
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
            <p className="font-heading tabular-nums">
              {row.amountType === "variable" ? "~" : ""}
              {formatMoney(absDisplayCents, row.displayAmount.currency as "COP" | "USD")}
            </p>
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
              / year
            </p>
          </div>
        </div>

        {/* Row: next occurrence + day */}
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <span>Next: {row.nextOccurrence}</span>
          <span>·</span>
          <span>Day {row.dayOfMonth}</span>
          {row.skippedMonths.length > 0 && (
            <>
              <span>·</span>
              <Badge variant="secondary" className="text-xs">
                {row.skippedMonths.length} skip{row.skippedMonths.length > 1 ? "s" : ""}
              </Badge>
            </>
          )}
        </div>

        {row.notes && <p className="text-muted-foreground text-xs italic">{row.notes}</p>}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main list
// ---------------------------------------------------------------------------

export function SubscriptionList({ rows, monthlyTotals, annualTotals }: SubscriptionListProps) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-muted-foreground text-sm">
            No active subscriptions found. Add them in{" "}
            <a href="/settings/recurring" className="underline underline-offset-4">
              Settings → Recurring
            </a>{" "}
            with the <strong>suscripciones</strong> category.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <TotalsHeader monthlyTotals={monthlyTotals} annualTotals={annualTotals} />
      <div className="flex flex-col gap-2">
        {rows.map((row) => (
          <SubscriptionCard key={row.id} row={row} />
        ))}
      </div>
    </div>
  );
}
