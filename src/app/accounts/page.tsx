import {
  CreditCardIcon,
  LandmarkIcon,
  PiggyBankIcon,
  WalletIcon,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { getNetWorth } from "@/lib/dashboard/queries";
import { listAccountsDetailed, type AccountDetail } from "@/lib/accounts/queries";
import { COP_PER_USD, formatCop, formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<AccountDetail["type"], string> = {
  savings: "Savings",
  credit_card: "Credit cards",
  loan: "Loans",
};

const TYPE_ORDER: AccountDetail["type"][] = ["savings", "credit_card", "loan"];

function sumBalanceCopCents(list: AccountDetail[]): bigint {
  let cop = BigInt(0);
  let usd = BigInt(0);
  for (const a of list) {
    if (a.currency === "USD") usd += a.balanceCents;
    else cop += a.balanceCents;
  }
  return cop + usd * BigInt(COP_PER_USD);
}

export default async function AccountsPage() {
  const [netWorth, all] = await Promise.all([
    getNetWorth(),
    listAccountsDetailed(),
  ]);

  const active = all.filter((a) => a.active);
  const inactive = all.filter((a) => !a.active);

  const grouped = TYPE_ORDER.map((type) => ({
    type,
    items: active.filter((a) => a.type === type),
  })).filter((g) => g.items.length > 0);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Accounts</h1>
        <p className="text-body text-muted-foreground">
          Saldos por cuenta agrupados por tipo. El patrimonio neto convierte USD
          a COP a {COP_PER_USD.toLocaleString("es-CO")} COP/USD.
        </p>
      </header>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard label="Net worth" valueCop={netWorth.totalCopCents} emphasis />
        <SummaryCard label="COP" value={formatMoney(netWorth.copCents, "COP")} />
        <SummaryCard label="USD" value={formatMoney(netWorth.usdCents, "USD")} />
      </section>

      {all.length === 0 ? (
        <Card>
          <EmptyState
            icon={<WalletIcon />}
            title="No accounts yet"
            description="Run the seed script or add accounts through the database to see balances here."
          />
        </Card>
      ) : null}

      {grouped.map(({ type, items }) => (
        <AccountTypeSection key={type} type={type} items={items} />
      ))}

      {inactive.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-h2 text-muted-foreground">Inactive</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {inactive.map((a) => (
              <AccountCard key={a.id} account={a} muted />
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}

function SummaryCard({
  label,
  value,
  valueCop,
  emphasis,
}: {
  label: string;
  value?: string;
  valueCop?: bigint;
  emphasis?: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 py-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div
          className={cn(
            "tabular-nums font-semibold",
            emphasis ? "text-2xl" : "text-lg",
          )}
        >
          {valueCop !== undefined ? formatCop(valueCop) : value}
        </div>
      </CardContent>
    </Card>
  );
}

function AccountTypeSection({
  type,
  items,
}: {
  type: AccountDetail["type"];
  items: AccountDetail[];
}) {
  const Icon = type === "credit_card"
    ? CreditCardIcon
    : type === "loan"
      ? LandmarkIcon
      : PiggyBankIcon;
  const subtotal = sumBalanceCopCents(items);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-h2 flex items-center gap-2">
          <Icon className="size-5 text-muted-foreground" />
          {TYPE_LABEL[type]}
        </h2>
        <div className="text-sm tabular-nums text-muted-foreground">
          {formatCop(subtotal)}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((a) => (
          <AccountCard key={a.id} account={a} />
        ))}
      </div>
    </section>
  );
}

function AccountCard({
  account,
  muted,
}: {
  account: AccountDetail;
  muted?: boolean;
}) {
  const negative = account.balanceCents < BigInt(0);
  const { metadata } = account;
  const last4 = metadata.last4s?.join(" · ");
  const meta: string[] = [];
  if (metadata.network) meta.push(metadata.network.toUpperCase());
  if (last4) meta.push(`*${last4}`);

  const creditLimit = metadata.creditLimitCents;
  const availableCredit = metadata.availableCreditCents;
  const loanRemaining = metadata.loanRemainingCents;
  const nextPayment = metadata.nextPaymentDate;

  return (
    <Card size="sm" className={cn(muted && "opacity-60")}>
      <CardHeader>
        <CardDescription className="flex items-center justify-between gap-2">
          <span className="truncate">{account.institution}</span>
          <span className="shrink-0 text-[10px] uppercase tracking-wide">
            {account.currency}
          </span>
        </CardDescription>
        <CardTitle className="truncate text-base">{account.name}</CardTitle>
        {meta.length > 0 ? (
          <div className="text-xs text-muted-foreground">{meta.join(" · ")}</div>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div
          className={cn(
            "text-xl tabular-nums font-semibold",
            negative ? "text-rose-600" : "text-foreground",
          )}
        >
          {formatMoney(account.balanceCents, account.currency)}
        </div>
        {account.type === "credit_card" && creditLimit ? (
          <CreditMeter
            currency={account.currency}
            limitCents={BigInt(creditLimit)}
            availableCents={
              availableCredit !== undefined ? BigInt(availableCredit) : null
            }
            balanceCents={account.balanceCents}
          />
        ) : null}
        {account.type === "loan" && loanRemaining ? (
          <div className="text-xs text-muted-foreground">
            Remaining: {formatMoney(BigInt(loanRemaining), account.currency)}
            {nextPayment ? ` · next ${nextPayment}` : ""}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CreditMeter({
  currency,
  limitCents,
  availableCents,
  balanceCents,
}: {
  currency: "COP" | "USD";
  limitCents: bigint;
  availableCents: bigint | null;
  balanceCents: bigint;
}) {
  const used =
    availableCents !== null
      ? limitCents - availableCents
      : balanceCents < BigInt(0)
        ? -balanceCents
        : BigInt(0);
  const pct =
    limitCents > BigInt(0)
      ? Math.min(100, Number((used * BigInt(10000)) / limitCents) / 100)
      : 0;
  const high = pct >= 80;

  return (
    <div className="flex flex-col gap-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full transition-all",
            high ? "bg-rose-600" : "bg-emerald-600",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
        <span>{formatMoney(used, currency)} used</span>
        <span>{formatMoney(limitCents, currency)} limit</span>
      </div>
    </div>
  );
}
