import Link from "next/link";
import { CreditCardIcon, LandmarkIcon, PiggyBankIcon, WalletIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { getSessionUser } from "@/lib/auth/session";
import { getNetWorth } from "@/lib/dashboard/queries";
import {
  groupCreditCards,
  listAccountsDetailed,
  type AccountDetail,
  type PhysicalCardSummary,
} from "@/lib/accounts/queries";
import { computeNextPayment } from "@/lib/accounts/next-payment";
import { computeUsedPct, isHeavyUsage } from "@/lib/accounts/meter";
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

const NEXT_PAYMENT_FMT = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

function formatNextPayment(isoDate: string): string {
  // Parse YYYY-MM-DD as UTC noon so the local-time conversion can't slip into
  // the previous day for negative-offset timezones (COT is UTC-5).
  return NEXT_PAYMENT_FMT.format(new Date(`${isoDate}T12:00:00Z`));
}

const currencyRank: Record<Currency, number> = { COP: 0, USD: 1 };

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
        <InactiveSection
          items={inactive}
          copPerUsd={fx.rate}
          fxFallback={fx.source === "fallback"}
        />
      ) : null}
    </main>
  );
}

function InactiveSection({
  items,
  copPerUsd,
  fxFallback,
}: {
  items: AccountDetail[];
  copPerUsd: number;
  fxFallback: boolean;
}) {
  // Keep credit_card rows grouped by physical_card so shared-cupo pairs still
  // render as one CreditCardTile (muted). Others render as muted AccountCard.
  const creditCards = items.filter((a) => a.type === "credit_card");
  const others = items.filter((a) => a.type !== "credit_card");
  const creditGroups = groupCreditCards(creditCards);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-h2 text-muted-foreground">Inactive</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {creditGroups.map((g) => (
          <CreditCardTile
            key={g[0].physicalCardId ?? `acct-${g[0].id}`}
            subs={g}
            copPerUsd={copPerUsd}
            fxFallback={fxFallback}
            muted
          />
        ))}
        {others.map((a) => (
          <AccountCard key={a.id} account={a} muted />
        ))}
      </div>
    </section>
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

  // credit_card items get grouped by physical_card — shared-cupo pairs share one
  // tile, single-currency cards end up as single-member groups. Grid layout is
  // the same as savings/loan: no col-span overrides, so every tile has the same
  // width for consistent UX across card types.
  const creditCardGroups: AccountDetail[][] | null =
    type === "credit_card" ? groupCreditCards(items) : null;

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
      <div
        className={cn(
          "grid grid-cols-1 gap-3 sm:grid-cols-2",
          type !== "credit_card" && "lg:grid-cols-3",
        )}
      >
        {creditCardGroups
          ? creditCardGroups.map((g) => (
              <CreditCardTile
                key={g[0].physicalCardId ?? `acct-${g[0].id}`}
                subs={g}
                copPerUsd={copPerUsd}
                fxFallback={fxFallback}
              />
            ))
          : items.map((a) => <AccountCard key={a.id} account={a} />)}
      </div>
    </section>
  );
}

function CreditCardTile({
  subs,
  copPerUsd,
  fxFallback,
  muted,
}: {
  subs: AccountDetail[];
  copPerUsd: number;
  fxFallback: boolean;
  muted?: boolean;
}) {
  const isShared = subs.length > 1 || Boolean(subs[0].physicalCard);
  const pc: PhysicalCardSummary | null = isShared ? subs[0].physicalCard : null;
  const primary = subs[0];
  const hasUsd = subs.some((s) => s.currency === "USD");
  const orderedSubs = [...subs].sort((a, b) => currencyRank[a.currency] - currencyRank[b.currency]);

  // Meter data: shared cards use physical_cards (limit always COP); single
  // cards use metadata in their native currency.
  let limitCents: bigint | null = null;
  let availableCents: bigint | null = null;
  let meterCurrency: Currency = "COP";
  if (isShared && pc) {
    limitCents = pc.creditLimitCents;
    let copDebt = BigInt(0);
    let usdDebt = BigInt(0);
    for (const s of subs) {
      if (s.currency === "COP") copDebt += s.balanceCents;
      else usdDebt += s.balanceCents;
    }
    availableCents = limitCents + copDebt + toCop(usdDebt, "USD", copPerUsd);
    meterCurrency = "COP";
  } else {
    const limit = primary.metadata.creditLimitCents;
    if (limit !== undefined && limit > 0) {
      limitCents = BigInt(limit);
      // #420: always derive from limit + ledger. The old
      // `metadata.availableCreditCents` snapshot path went stale whenever a
      // purchase landed via SMS/manual without a balance-adjust.
      availableCents = limitCents + primary.balanceCents;
    }
    meterCurrency = primary.currency;
  }

  const cutoffDay = isShared && pc ? pc.statementCutoffDay : (primary.metadata.cutoffDay ?? null);
  const nextPaymentDate = computeNextPayment(cutoffDay, new Date());

  const badge = isShared ? "Cupo compartido" : primary.currency;
  const network = isShared && pc ? pc.network : (primary.metadata.network ?? null);
  const last4 = isShared && pc ? pc.last4 : (primary.metadata.last4s?.[0] ?? null);
  const title = (isShared && pc?.name) || primary.name;
  const metaParts: string[] = [];
  if (network) metaParts.push(network.toUpperCase());
  if (last4) metaParts.push(`*${last4}`);

  return (
    <Card size="sm" className={cn(muted && "opacity-60")}>
      <CardHeader>
        <CardDescription className="flex items-center justify-between gap-2">
          <span className="truncate">{primary.institution}</span>
          <span className="shrink-0 text-[10px] tracking-wide uppercase">{badge}</span>
        </CardDescription>
        <CardTitle className="truncate text-base">{title}</CardTitle>
        {metaParts.length > 0 ? (
          <div className="text-muted-foreground text-xs">{metaParts.join(" · ")}</div>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <div className="text-muted-foreground text-xs">Deuda a la fecha</div>
          <div className="flex flex-col gap-1">
            {orderedSubs.map((s) => (
              <DebtRow key={s.id} account={s} />
            ))}
            {orderedSubs.length < 2 ? <DebtRowPlaceholder /> : null}
          </div>
        </div>
        <CreditMeter
          limitCents={limitCents}
          availableCents={availableCents}
          currency={meterCurrency}
          fxFallback={isShared && fxFallback && hasUsd}
        />
        <FooterMeta
          nextPaymentDate={nextPaymentDate}
          showTRM={isShared && hasUsd}
          trmRate={copPerUsd}
          fxFallback={fxFallback}
        />
      </CardContent>
    </Card>
  );
}

function DebtRow({ account }: { account: AccountDetail }) {
  const negative = account.balanceCents < BigInt(0);
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground text-[10px] tracking-wide uppercase">
        {account.currency}
      </span>
      <span
        className={cn(
          "text-lg font-semibold tabular-nums",
          negative ? "text-rose-600" : "text-foreground",
        )}
      >
        <Money cents={account.balanceCents} currency={account.currency} />
      </span>
    </div>
  );
}

function DebtRowPlaceholder() {
  return (
    <div aria-hidden className="invisible flex items-baseline justify-between gap-2">
      <span className="text-[10px] tracking-wide uppercase">—</span>
      <span className="text-lg font-semibold tabular-nums">—</span>
    </div>
  );
}

function CreditMeter({
  limitCents,
  availableCents,
  currency,
  fxFallback,
}: {
  limitCents: bigint | null;
  availableCents: bigint | null;
  currency: Currency;
  fxFallback: boolean;
}) {
  if (limitCents === null || availableCents === null || limitCents === BigInt(0)) {
    return (
      <div className="flex flex-col gap-1">
        <div className="bg-muted h-1.5 overflow-hidden rounded-full" />
        <div className="text-muted-foreground flex items-center justify-between text-xs tabular-nums">
          <span>Cupo disponible: —</span>
          <span>Total: —</span>
        </div>
      </div>
    );
  }
  const pct = computeUsedPct(limitCents, availableCents);
  const high = isHeavyUsage(pct);
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
          Cupo disponible: <Money cents={availableCents} currency={currency} />
          {fxFallback ? " (TRM fallback)" : ""}
        </span>
        <span>
          Total: <Money cents={limitCents} currency={currency} />
        </span>
      </div>
    </div>
  );
}

function FooterMeta({
  nextPaymentDate,
  showTRM,
  trmRate,
  fxFallback,
}: {
  nextPaymentDate: string | null;
  showTRM: boolean;
  trmRate: number;
  fxFallback: boolean;
}) {
  return (
    <div className="text-muted-foreground flex flex-col gap-0.5 text-xs">
      <div className="flex items-center justify-between">
        <span>Próximo pago</span>
        <span className="tabular-nums">
          {nextPaymentDate ? formatNextPayment(nextPaymentDate) : "—"}
        </span>
      </div>
      <div
        aria-hidden={!showTRM}
        className={cn("flex items-center justify-between", !showTRM && "invisible")}
      >
        <span>TRM{fxFallback ? " (fallback)" : ""}</span>
        <span className="tabular-nums">$ {RATE_FMT.format(trmRate)}</span>
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
