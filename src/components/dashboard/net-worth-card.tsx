import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AnimatedMoney } from "@/components/ui/animated-money";
import type { NetWorth } from "@/lib/dashboard/queries";
import type { FxRate } from "@/lib/fx/repo";

const SHORT_DATE = new Intl.DateTimeFormat("es-CO", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

const RATE_FMT = new Intl.NumberFormat("es-CO", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatFxAsOf(asOf: string): string {
  const [y, m, d] = asOf.split("-").map(Number);
  if (!y || !m || !d) return asOf;
  return SHORT_DATE.format(new Date(Date.UTC(y, m - 1, d)));
}

export function NetWorthCard({ data, fx }: { data: NetWorth; fx: FxRate }) {
  const label = fx.source === "fallback"
    ? `@ ${RATE_FMT.format(fx.rate)} COP/USD · fallback`
    : `@ ${RATE_FMT.format(fx.rate)} COP/USD · TRM ${formatFxAsOf(fx.asOf)}`;

  return (
    <Card>
      <CardHeader>
        <CardDescription>Net worth</CardDescription>
        <CardTitle className="text-3xl tabular-nums">
          <AnimatedMoney cents={data.totalCopCents} currency="COP" />
        </CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1">
            COP <AnimatedMoney cents={data.copCents} currency="COP" />
          </span>
          <span className="inline-flex items-center gap-1">
            USD <AnimatedMoney cents={data.usdCents} currency="USD" />
          </span>
          <span className="opacity-60">{label}</span>
        </div>
      </CardContent>
    </Card>
  );
}
