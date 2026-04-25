import { AnimatedMoney } from "@/components/ui/animated-money";
import { Money } from "@/components/display/money";
import { cn } from "@/lib/utils";
import type { FinancialPicture } from "@/lib/dashboard/queries";
import type { FxRate } from "@/lib/fx/repo";

const SHORT_DATE = new Intl.DateTimeFormat("es-CO", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

const RATE_FMT = new Intl.NumberFormat("es-CO", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatFxAsOf(asOf: string): string {
  const [y, m, d] = asOf.split("-").map(Number);
  if (!y || !m || !d) return asOf;
  return SHORT_DATE.format(new Date(Date.UTC(y, m - 1, d)));
}

function pctOf(part: bigint, whole: bigint): number {
  if (whole <= BigInt(0)) return 0;
  return Math.min(100, Math.max(0, Number((part * BigInt(10000)) / whole) / 100));
}

export function SaldoLiquidoCard({
  data,
  fx,
  monthLabel,
}: {
  data: FinancialPicture;
  fx: FxRate;
  monthLabel: string;
}) {
  const total = data.liquidCopCents + data.liabilitiesCopCents;
  const assetPct = pctOf(data.liquidCopCents, total);
  const fxLabel =
    fx.source === "fallback"
      ? `@ ${RATE_FMT.format(fx.rate)} COP/USD · fallback`
      : `@ ${RATE_FMT.format(fx.rate)} COP/USD · TRM ${formatFxAsOf(fx.asOf)}`;

  const hasDebts = data.liabilitiesCopCents > BigInt(0);
  const netNegative = data.netWorthCopCents < BigInt(0);

  return (
    <article
      className={cn(
        "card-paper paper-rise relative overflow-hidden p-8 sm:p-10",
        "flex flex-col gap-7 lg:flex-row lg:items-end lg:justify-between lg:gap-12",
      )}
    >
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span className="text-eyebrow">Saldo líquido</span>
          <span className="text-ink-subtle text-xs capitalize">· {monthLabel}</span>
        </div>
        <h2 className="money-hero text-ink text-6xl leading-none sm:text-7xl">
          <AnimatedMoney cents={data.liquidCopCents} currency="COP" />
        </h2>
        <p className="text-ink-muted text-sm">
          Disponible hoy en cuentas de ahorro
          <span className="text-ink-subtle"> · {fxLabel}</span>
        </p>
        {data.liquidUsdCents > BigInt(0) || data.liquidCopOnlyCents > BigInt(0) ? (
          <div className="text-ink-muted flex flex-wrap gap-x-5 gap-y-1 pt-1 text-xs tabular-nums">
            <span className="inline-flex items-center gap-1.5">
              <span className="text-ink-subtle tracking-wider uppercase">COP</span>
              <Money cents={data.liquidCopOnlyCents} currency="COP" />
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="text-ink-subtle tracking-wider uppercase">USD</span>
              <Money cents={data.liquidUsdCents} currency="USD" />
            </span>
          </div>
        ) : null}
      </header>

      {hasDebts ? (
        <aside className="border-rule flex min-w-[14rem] flex-col gap-2 border-t pt-5 lg:max-w-xs lg:border-t-0 lg:border-l lg:pt-0 lg:pl-10">
          <span className="text-eyebrow">Patrimonio neto</span>
          <div className={cn("money-hero text-2xl", netNegative ? "text-amber-soft" : "text-ink")}>
            <Money cents={data.netWorthCopCents} currency="COP" />
          </div>
          <div className="meter-track mt-1 h-1.5">
            <div className="meter-fill" style={{ width: `${assetPct}%` }} />
          </div>
          <div className="text-ink-subtle flex justify-between text-[11px] tabular-nums">
            <span>
              Activos <span className="text-ink-muted">·</span>{" "}
              <Money cents={data.liquidCopCents} currency="COP" />
            </span>
            <span>
              Deudas <span className="text-ink-muted">·</span>{" "}
              <Money cents={data.liabilitiesCopCents} currency="COP" />
            </span>
          </div>
        </aside>
      ) : null}
    </article>
  );
}
