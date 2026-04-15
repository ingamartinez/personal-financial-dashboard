import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatCop } from "@/lib/money";
import type { MonthlyFlow } from "@/lib/dashboard/queries";

export function MonthlyFlowCard({ data, monthLabel }: { data: MonthlyFlow; monthLabel: string }) {
  const positive = data.netCopCents >= BigInt(0);
  return (
    <Card>
      <CardHeader>
        <CardDescription>Cash flow · {monthLabel}</CardDescription>
        <CardTitle
          className={cn(
            "text-3xl tabular-nums",
            positive ? "text-emerald-600" : "text-rose-600",
          )}
        >
          {positive ? "+" : "−"}
          {formatCop(data.netCopCents < BigInt(0) ? data.netCopCents * BigInt(-1) : data.netCopCents)}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-muted-foreground">Income</div>
          <div className="font-medium tabular-nums text-emerald-600">
            {formatCop(data.incomeCopCents)}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Expenses</div>
          <div className="font-medium tabular-nums text-rose-600">
            {formatCop(data.expenseCopCents)}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
