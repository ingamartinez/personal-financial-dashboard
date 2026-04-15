import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/money";
import type { TopExpense } from "@/lib/dashboard/queries";

const dateFmt = new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "short" });

export function TopExpensesCard({ rows, monthLabel }: { rows: TopExpense[]; monthLabel: string }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>Top expenses · {monthLabel}</CardDescription>
        <CardTitle className="text-base">{rows.length} of top 5</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="text-sm text-muted-foreground">No expenses this month</div>
        ) : (
          <ul className="flex flex-col divide-y">
            {rows.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium">
                    {r.merchant ?? r.description}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {dateFmt.format(r.occurredAt)} · {r.accountName}
                    {r.categoryName ? ` · ${r.categoryName}` : ""}
                  </div>
                </div>
                <div className="shrink-0 text-right tabular-nums font-medium text-rose-600">
                  −{formatMoney(r.amountCents < BigInt(0) ? r.amountCents * BigInt(-1) : r.amountCents, r.currency)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
