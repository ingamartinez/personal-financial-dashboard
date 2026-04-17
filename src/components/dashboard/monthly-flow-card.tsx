import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AnimatedMoney } from "@/components/ui/animated-money";
import { cn } from "@/lib/utils";
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
          <AnimatedMoney
            cents={data.netCopCents}
            currency="COP"
            signDisplay="always"
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-muted-foreground">Income</div>
          <div className="font-medium tabular-nums text-emerald-600">
            <AnimatedMoney cents={data.incomeCopCents} currency="COP" />
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Expenses</div>
          <div className="font-medium tabular-nums text-rose-600">
            <AnimatedMoney cents={data.expenseCopCents} currency="COP" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
