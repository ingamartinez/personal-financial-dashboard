import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Money } from "@/components/display/money";
import type { AccountStatus } from "@/lib/dashboard/queries";

const TYPE_LABEL: Record<AccountStatus["type"], string> = {
  savings: "Savings",
  credit_card: "Credit card",
  loan: "Loan",
};

export function AccountsGrid({ accounts }: { accounts: AccountStatus[] }) {
  if (accounts.length === 0) {
    return (
      <Card>
        <CardContent className="text-muted-foreground py-6 text-sm">No active accounts</CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {accounts.map((a) => {
        const negative = a.balanceCents < BigInt(0);
        return (
          <Card key={a.id} size="sm">
            <CardHeader>
              <CardDescription>
                {a.institution} · {TYPE_LABEL[a.type]}
              </CardDescription>
              <CardTitle className="truncate text-base">{a.name}</CardTitle>
            </CardHeader>
            <CardContent>
              <div
                className={cn(
                  "text-xl font-semibold tabular-nums",
                  negative ? "text-rose-600" : "text-foreground",
                )}
              >
                <Money cents={a.balanceCents} currency={a.currency} />
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
