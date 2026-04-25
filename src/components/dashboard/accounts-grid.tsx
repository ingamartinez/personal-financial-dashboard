import { Money } from "@/components/display/money";
import { cn } from "@/lib/utils";
import type { AccountStatus } from "@/lib/dashboard/queries";

const TYPE_LABEL: Record<AccountStatus["type"], string> = {
  savings: "Ahorros",
  credit_card: "Tarjeta",
  loan: "Préstamo",
};

function pctOf(part: bigint, whole: bigint): number {
  if (whole <= BigInt(0)) return 0;
  return Math.min(100, Math.max(0, Number((part * BigInt(10000)) / whole) / 100));
}

export function AccountsGrid({ accounts }: { accounts: AccountStatus[] }) {
  if (accounts.length === 0) {
    return (
      <div className="card-paper text-ink-muted px-6 py-7 text-sm">No hay cuentas activas.</div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {accounts.map((a) => {
        if (a.type === "credit_card" && a.creditLimitCents && a.creditLimitCents > BigInt(0)) {
          const debt = a.balanceCents < BigInt(0) ? -a.balanceCents : BigInt(0);
          const limit = a.creditLimitCents;
          const available = limit + a.balanceCents;
          const usedPct = pctOf(debt, limit);
          const heavy = usedPct >= 80;
          return (
            <article key={a.id} className="card-paper flex flex-col gap-3 p-5">
              <header className="flex flex-col gap-0.5">
                <span className="text-eyebrow">
                  {a.institution} · {TYPE_LABEL[a.type]}
                </span>
                <h3 className="text-ink truncate text-base font-medium">{a.name}</h3>
              </header>

              <div className="flex flex-col gap-1">
                <span className="text-ink-subtle text-[11px] tracking-wider uppercase">
                  Disponible
                </span>
                <div className="money-hero text-botanical-fg text-2xl">
                  <Money cents={available} currency={a.currency} />
                </div>
              </div>

              <div className="meter-track h-1.5">
                <div
                  className={cn(heavy ? "meter-fill-amber" : "meter-fill")}
                  style={{ width: `${usedPct}%` }}
                />
              </div>
              <div className="text-ink-subtle flex justify-between text-[11px] tabular-nums">
                <span>
                  Usado <Money cents={debt} currency={a.currency} />
                </span>
                <span>
                  Cupo <Money cents={limit} currency={a.currency} />
                </span>
              </div>
            </article>
          );
        }

        return (
          <article key={a.id} className="card-paper flex flex-col gap-3 p-5">
            <header className="flex flex-col gap-0.5">
              <span className="text-eyebrow">
                {a.institution} · {TYPE_LABEL[a.type]}
              </span>
              <h3 className="text-ink truncate text-base font-medium">{a.name}</h3>
            </header>
            <div className="money-hero text-ink text-2xl">
              <Money cents={a.balanceCents} currency={a.currency} />
            </div>
          </article>
        );
      })}
    </div>
  );
}
