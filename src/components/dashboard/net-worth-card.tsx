import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { COP_PER_USD, formatCop, formatMoney } from "@/lib/money";
import type { NetWorth } from "@/lib/dashboard/queries";

export function NetWorthCard({ data }: { data: NetWorth }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>Net worth</CardDescription>
        <CardTitle className="text-3xl tabular-nums">
          {formatCop(data.totalCopCents)}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <span>
            COP {formatMoney(data.copCents, "COP")}
          </span>
          <span>
            USD {formatMoney(data.usdCents, "USD")}
          </span>
          <span className="opacity-60">@ {COP_PER_USD.toLocaleString("es-CO")} COP/USD</span>
        </div>
      </CardContent>
    </Card>
  );
}
