import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Money } from "@/components/display/money";
import { cn } from "@/lib/utils";
import type { CreditCardsSummary } from "@/lib/dashboard/queries";

const NEXT_PAYMENT_FMT = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "short",
});

function formatNextPayment(isoDate: string): string {
  return NEXT_PAYMENT_FMT.format(new Date(`${isoDate}T12:00:00Z`));
}

function formatDaysUntil(days: number): string {
  if (days <= 0) return "hoy";
  if (days === 1) return "mañana";
  return `en ${days} días`;
}

export function CreditCardsCard({ data }: { data: CreditCardsSummary }) {
  if (data.cardCount === 0) return null;
  const negative = data.debtCopCents < BigInt(0);
  const showMeter = data.limitCopCents > BigInt(0);
  const usedPctLabel = `${Math.round(data.usedPct)}%`;
  const high = data.usedPct >= 80;

  return (
    <Card>
      <CardHeader>
        <CardDescription className="flex items-center justify-between gap-2">
          <span>Credit cards</span>
          <Link
            href="/accounts"
            className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
          >
            Ver detalle →
          </Link>
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <div className="text-muted-foreground text-xs">Deuda total</div>
          <div
            className={cn(
              "text-2xl font-semibold tabular-nums",
              negative ? "text-rose-600" : "text-foreground",
            )}
          >
            <Money cents={data.debtCopCents} currency="COP" />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="text-muted-foreground text-xs">Cupo disponible</div>
          {showMeter ? (
            <>
              <div className="text-2xl font-semibold tabular-nums">
                <Money cents={data.availableCopCents} currency="COP" />
              </div>
              <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                <div
                  className={cn("h-full transition-all", high ? "bg-rose-600" : "bg-emerald-600")}
                  style={{ width: `${data.usedPct}%` }}
                />
              </div>
              <div className="text-muted-foreground text-xs tabular-nums">
                {usedPctLabel} usado de <Money cents={data.limitCopCents} currency="COP" />
              </div>
            </>
          ) : (
            <div className="text-muted-foreground text-base">—</div>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <div className="text-muted-foreground text-xs">Próximo pago</div>
          {data.nextPayment ? (
            <>
              <div className="text-2xl font-semibold tabular-nums">
                {formatNextPayment(data.nextPayment.date)}
              </div>
              <div className="text-muted-foreground text-xs">
                {formatDaysUntil(data.nextPayment.daysUntil)}
              </div>
            </>
          ) : (
            <div className="text-muted-foreground text-base">—</div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
