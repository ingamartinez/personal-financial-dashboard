import { Money } from "@/components/display/money";
import { CreditMeterBar } from "@/components/accounts/credit-meter-bar";
import { formatAccountLabel } from "@/lib/accounts/format";
import { groupCreditCards } from "@/lib/accounts/queries";
import { toCop } from "@/lib/money";
import type { AccountDetail } from "@/lib/accounts/queries";
import type { Currency } from "@/lib/types";

// COP before USD so the COP leg always renders first in the breakdown.
const CURRENCY_RANK: Record<Currency, number> = { COP: 0, USD: 1 };

function SharedCreditCardTile({ group, copPerUsd }: { group: AccountDetail[]; copPerUsd: number }) {
  const pc = group[0].physicalCard!;
  const primary = group[0];

  const limitCents = pc.creditLimitCents;

  let copDebt = BigInt(0);
  let usdDebt = BigInt(0);
  for (const s of group) {
    if (s.currency === "COP") copDebt += s.balanceCents;
    else usdDebt += s.balanceCents;
  }
  const availableCents = limitCents + copDebt + toCop(usdDebt, "USD", copPerUsd);

  const title = pc.name ?? primary.name;

  // Per-leg breakdown rows, sorted COP first.
  const legs = group
    .filter((s) => s.balanceCents < BigInt(0))
    .sort((a, b) => (CURRENCY_RANK[a.currency] ?? 99) - (CURRENCY_RANK[b.currency] ?? 99));

  return (
    <article className="card-paper flex flex-col gap-3 p-5">
      <header className="flex flex-col gap-0.5">
        <span className="text-eyebrow">{primary.institution} · Tarjeta</span>
        <h3 className="text-ink truncate text-base font-medium">{title}</h3>
      </header>

      <div className="flex flex-col gap-1">
        <span className="text-ink-subtle text-[11px] tracking-wider uppercase">Disponible</span>
        <div className="money-hero text-botanical-fg text-2xl">
          <Money cents={availableCents} currency="COP" />
        </div>
      </div>

      <CreditMeterBar limitCents={limitCents} availableCents={availableCents} />

      {legs.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          {legs.map((s) => (
            <div
              key={s.id}
              className="text-ink-subtle flex items-center justify-between text-[11px] tabular-nums"
            >
              <span className="text-ink-muted font-medium uppercase">{s.currency}</span>
              <span>
                Usado <Money cents={-s.balanceCents} currency={s.currency} />
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="text-ink-subtle flex justify-end text-[11px] tabular-nums">
        <span>
          Cupo <Money cents={limitCents} currency="COP" />
        </span>
      </div>
    </article>
  );
}

function SingleCreditCardTile({ account }: { account: AccountDetail }) {
  const limit = account.metadata.creditLimitCents;
  const limitCents = limit !== undefined && limit > 0 ? BigInt(limit) : null;
  const availableCents = limitCents !== null ? limitCents + account.balanceCents : null;
  const debt = account.balanceCents < BigInt(0) ? -account.balanceCents : BigInt(0);

  return (
    <article className="card-paper flex flex-col gap-3 p-5">
      <header className="flex flex-col gap-0.5">
        <span className="text-eyebrow">{account.institution} · Tarjeta</span>
        <h3 className="text-ink truncate text-base font-medium">{formatAccountLabel(account)}</h3>
      </header>

      {availableCents !== null ? (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-ink-subtle text-[11px] tracking-wider uppercase">Disponible</span>
            <div className="money-hero text-botanical-fg text-2xl">
              <Money cents={availableCents} currency={account.currency} />
            </div>
          </div>

          <CreditMeterBar limitCents={limitCents} availableCents={availableCents} />

          <div className="text-ink-subtle flex justify-between text-[11px] tabular-nums">
            <span>
              Usado <Money cents={debt} currency={account.currency} />
            </span>
            <span>
              Cupo <Money cents={limitCents!} currency={account.currency} />
            </span>
          </div>
        </>
      ) : (
        <div className="money-hero text-ink text-2xl">
          <Money cents={account.balanceCents} currency={account.currency} />
        </div>
      )}
    </article>
  );
}

function OtherAccountTile({ account }: { account: AccountDetail }) {
  const TYPE_LABEL: Record<string, string> = {
    savings: "Ahorros",
    loan: "Préstamo",
    cash: "Efectivo",
  };
  return (
    <article className="card-paper flex flex-col gap-3 p-5">
      <header className="flex flex-col gap-0.5">
        <span className="text-eyebrow">
          {account.institution} · {TYPE_LABEL[account.type] ?? account.type}
        </span>
        <h3 className="text-ink truncate text-base font-medium">{formatAccountLabel(account)}</h3>
      </header>
      <div className="money-hero text-ink text-2xl">
        <Money cents={account.balanceCents} currency={account.currency} />
      </div>
    </article>
  );
}

export function AccountsGrid({
  accounts,
  copPerUsd,
}: {
  accounts: AccountDetail[];
  copPerUsd: number;
}) {
  const active = accounts.filter((a) => a.active);

  if (active.length === 0) {
    return (
      <div className="card-paper text-ink-muted px-6 py-7 text-sm">No hay cuentas activas.</div>
    );
  }

  const creditCards = active.filter((a) => a.type === "credit_card");
  const others = active.filter((a) => a.type !== "credit_card");

  const creditCardGroups = groupCreditCards(creditCards);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {creditCardGroups.map((group) => {
        const isShared = group.length > 1 || Boolean(group[0].physicalCard);
        if (isShared) {
          return (
            <SharedCreditCardTile
              key={group[0].physicalCard?.id ?? group[0].id}
              group={group}
              copPerUsd={copPerUsd}
            />
          );
        }
        return <SingleCreditCardTile key={group[0].id} account={group[0]} />;
      })}
      {others.map((a) => (
        <OtherAccountTile key={a.id} account={a} />
      ))}
    </div>
  );
}
