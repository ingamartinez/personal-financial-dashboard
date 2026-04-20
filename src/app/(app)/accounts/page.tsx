import Link from "next/link";
import { CreditCardIcon, LandmarkIcon, PiggyBankIcon, WalletIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { getSessionUser } from "@/lib/auth/session";
import { getNetWorth } from "@/lib/dashboard/queries";
import {
  listAccountsDetailed,
  type AccountDetail,
  type PhysicalCardSummary,
} from "@/lib/accounts/queries";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { toCop } from "@/lib/money";
import { Money } from "@/components/display/money";
import type { Currency } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

const RATE_FMT = new Intl.NumberFormat("es-CO", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<AccountDetail["type"], string> = {
  savings: "Savings",
  credit_card: "Credit cards",
  loan: "Loans",
};

const TYPE_ORDER: AccountDetail["type"][] = ["savings", "credit_card", "loan"];

function sumBalanceCopCents(list: AccountDetail[], copPerUsd: number): bigint {
  let cop = BigInt(0);
  let usd = BigInt(0);
  for (const a of list) {
    if (a.currency === "USD") usd += a.balanceCents;
    else cop += a.balanceCents;
  }
  return cop + toCop(usd, "USD", copPerUsd);
}

export default async function AccountsPage() {
  const session = await getSessionUser();
  const fx = await getCurrentFxRate();
  const [netWorth, all] = await Promise.all([
    getNetWorth(session.id, fx.rate),
    listAccountsDetailed(session.id),
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
          Saldos por cuenta agrupados por tipo. Las conversiones usan {RATE_FMT.format(fx.rate)}{" "}
          COP/USD
          {fx.source === "fallback" ? " (fallback)" : ` (TRM ${fx.asOf})`}.
        </p>
      </header>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard
          label="Net worth"
          value={<Money cents={netWorth.totalCopCents} currency="COP" />}
          emphasis
        />
        <SummaryCard label="COP" value={<Money cents={netWorth.copCents} currency="COP" />} />
        <SummaryCard label="USD" value={<Money cents={netWorth.usdCents} currency="USD" />} />
      </section>

      {all.length === 0 ? (
        <Card>
          <EmptyState
            icon={<WalletIcon />}
            title="No accounts yet"
            description="Create your first account to start tracking balances and transactions."
            action={
              <Button asChild>
                <Link href="/settings/accounts">Create account</Link>
              </Button>
            }
          />
        </Card>
      ) : null}

      {grouped.map(({ type, items }) => (
        <AccountTypeSection
          key={type}
          type={type}
          items={items}
          copPerUsd={fx.rate}
          fxFallback={fx.source === "fallback"}
        />
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
  emphasis,
}: {
  label: string;
  value: ReactNode;
  emphasis?: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 py-4">
        <div className="text-muted-foreground text-xs">{label}</div>
        <div className={cn("font-semibold tabular-nums", emphasis ? "text-2xl" : "text-lg")}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function AccountTypeSection({
  type,
  items,
  copPerUsd,
  fxFallback,
}: {
  type: AccountDetail["type"];
  items: AccountDetail[];
  copPerUsd: number;
  fxFallback: boolean;
}) {
  const Icon =
    type === "credit_card" ? CreditCardIcon : type === "loan" ? LandmarkIcon : PiggyBankIcon;
  const subtotal = sumBalanceCopCents(items, copPerUsd);

  // Multi-currency credit cards (sharing a physicalCardId) render as one grouped
  // tile with the shared cupo; remaining single-currency cards render as before.
  const pairs = new Map<string, AccountDetail[]>();
  const singles: AccountDetail[] = [];
  if (type === "credit_card") {
    for (const a of items) {
      if (a.physicalCardId && a.physicalCard) {
        const arr = pairs.get(a.physicalCardId) ?? [];
        arr.push(a);
        pairs.set(a.physicalCardId, arr);
      } else {
        singles.push(a);
      }
    }
  } else {
    singles.push(...items);
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-h2 flex items-center gap-2">
          <Icon className="text-muted-foreground size-5" />
          {TYPE_LABEL[type]}
        </h2>
        <div className="text-muted-foreground text-sm tabular-nums">
          <Money cents={subtotal} currency="COP" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from(pairs.values()).map((subs) => (
          <PhysicalCardGroup
            key={subs[0].physicalCardId!}
            subs={subs}
            copPerUsd={copPerUsd}
            fxFallback={fxFallback}
          />
        ))}
        {singles.map((a) => (
          <AccountCard key={a.id} account={a} />
        ))}
      </div>
    </section>
  );
}

function PhysicalCardGroup({
  subs,
  copPerUsd,
  fxFallback,
}: {
  subs: AccountDetail[];
  copPerUsd: number;
  fxFallback: boolean;
}) {
  const pc = subs[0].physicalCard as PhysicalCardSummary;
  // available = limit + COP debts + USD debts × rate (balances are negative).
  let copDebt = BigInt(0);
  let usdDebt = BigInt(0);
  for (const s of subs) {
    if (s.currency === "COP") copDebt += s.balanceCents;
    else usdDebt += s.balanceCents;
  }
  const availableCop = pc.creditLimitCents + copDebt + toCop(usdDebt, "USD", copPerUsd);
  const institution = subs[0].institution;
  const label = pc.network ? `${institution} ${pc.network.toUpperCase()}` : institution;
  const last4 = pc.last4 ? `*${pc.last4}` : null;

  return (
    <Card size="sm" className="sm:col-span-2 lg:col-span-3">
      <CardHeader>
        <CardDescription className="flex items-center justify-between gap-2">
          <span className="truncate">{label}</span>
          <span className="shrink-0 text-[10px] tracking-wide uppercase">Shared cupo</span>
        </CardDescription>
        <CardTitle className="truncate text-base">
          Multi-currency card{last4 ? ` ${last4}` : ""}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <SharedCupoMeter
          limitCents={pc.creditLimitCents}
          availableCents={availableCop}
          fxFallback={fxFallback}
        />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {subs.map((s) => (
            <SubAccountTile key={s.id} account={s} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function SubAccountTile({ account }: { account: AccountDetail }) {
  const negative = account.balanceCents < BigInt(0);
  return (
    <div className="bg-muted/30 flex flex-col gap-0.5 rounded-md p-2">
      <div className="text-muted-foreground flex items-center justify-between text-[10px] tracking-wide uppercase">
        <span>{account.currency}</span>
      </div>
      <div
        className={cn(
          "text-lg font-semibold tabular-nums",
          negative ? "text-rose-600" : "text-foreground",
        )}
      >
        <Money cents={account.balanceCents} currency={account.currency} />
      </div>
    </div>
  );
}

function SharedCupoMeter({
  limitCents,
  availableCents,
  fxFallback,
}: {
  limitCents: bigint;
  availableCents: bigint;
  fxFallback: boolean;
}) {
  const used = limitCents > availableCents ? limitCents - availableCents : BigInt(0);
  const pct =
    limitCents > BigInt(0) ? Math.min(100, Number((used * BigInt(10000)) / limitCents) / 100) : 0;
  const high = pct >= 80;

  return (
    <div className="flex flex-col gap-1">
      <div className="bg-muted h-1.5 overflow-hidden rounded-full">
        <div
          className={cn("h-full transition-all", high ? "bg-rose-600" : "bg-emerald-600")}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-muted-foreground flex items-center justify-between text-xs tabular-nums">
        <span>
          <Money cents={used} currency="COP" /> used
        </span>
        <span>
          <Money cents={limitCents} currency="COP" /> limit
        </span>
      </div>
      <div className="text-muted-foreground flex items-center justify-between text-[10px]">
        <span>
          Disponible: <Money cents={availableCents} currency="COP" />
          {fxFallback ? " · cupo estimado (TRM fallback)" : ""}
        </span>
      </div>
    </div>
  );
}

function AccountCard({ account, muted }: { account: AccountDetail; muted?: boolean }) {
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
          <span className="shrink-0 text-[10px] tracking-wide uppercase">{account.currency}</span>
        </CardDescription>
        <CardTitle className="truncate text-base">{account.name}</CardTitle>
        {meta.length > 0 ? (
          <div className="text-muted-foreground text-xs">{meta.join(" · ")}</div>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div
          className={cn(
            "text-xl font-semibold tabular-nums",
            negative ? "text-rose-600" : "text-foreground",
          )}
        >
          <Money cents={account.balanceCents} currency={account.currency} />
        </div>
        {account.type === "credit_card" && creditLimit ? (
          <CreditMeter
            currency={account.currency}
            limitCents={BigInt(creditLimit)}
            availableCents={availableCredit !== undefined ? BigInt(availableCredit) : null}
            balanceCents={account.balanceCents}
          />
        ) : null}
        {account.type === "loan" && loanRemaining ? (
          <div className="text-muted-foreground text-xs">
            Remaining: <Money cents={BigInt(loanRemaining)} currency={account.currency} />
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
  currency: Currency;
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
    limitCents > BigInt(0) ? Math.min(100, Number((used * BigInt(10000)) / limitCents) / 100) : 0;
  const high = pct >= 80;

  return (
    <div className="flex flex-col gap-1">
      <div className="bg-muted h-1.5 overflow-hidden rounded-full">
        <div
          className={cn("h-full transition-all", high ? "bg-rose-600" : "bg-emerald-600")}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-muted-foreground flex items-center justify-between text-xs tabular-nums">
        <span>
          <Money cents={used} currency={currency} /> used
        </span>
        <span>
          <Money cents={limitCents} currency={currency} /> limit
        </span>
      </div>
    </div>
  );
}
