import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AnimatedMoney } from "@/components/ui/animated-money";
import { cn } from "@/lib/utils";
import type { MonthlyFlow } from "@/lib/dashboard/queries";

export function MonthlyFlowCard({
  data,
  monthLabel,
  isFuture = false,
}: {
  data: MonthlyFlow;
  monthLabel: string;
  isFuture?: boolean;
}) {
  const positive = data.netCopCents >= BigInt(0);
  if (isFuture) {
    return (
      <Card>
        <CardHeader>
          <CardDescription>Cash flow · {monthLabel}</CardDescription>
          <CardTitle className="text-muted-foreground text-base font-normal">
            Sin datos todavía
          </CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-xs">
          Este mes aún no ocurrió.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardDescription>Cash flow · {monthLabel}</CardDescription>
        <CardTitle
          className={cn("text-3xl tabular-nums", positive ? "text-emerald-600" : "text-rose-600")}
        >
          <AnimatedMoney cents={data.netCopCents} currency="COP" signDisplay="always" />
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-muted-foreground">Income</div>
          <div className="font-medium text-emerald-600 tabular-nums">
            <AnimatedMoney cents={data.incomeCopCents} currency="COP" />
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Expenses</div>
          <div className="font-medium text-rose-600 tabular-nums">
            <AnimatedMoney cents={data.expenseCopCents} currency="COP" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
