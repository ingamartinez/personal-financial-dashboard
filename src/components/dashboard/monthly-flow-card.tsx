import { AnimatedMoney } from "@/components/ui/animated-money";
import { cn } from "@/lib/utils";
import type { MonthlyFlow } from "@/lib/dashboard/queries";
import {
  formatPeriodDateRange,
  periodFallbackNote,
  type FinancialPeriod,
} from "@/lib/dashboard/period-format";

function pctOf(part: bigint, whole: bigint): number {
  if (whole <= BigInt(0)) return 0;
  return Math.min(100, Math.max(0, Number((part * BigInt(10000)) / whole) / 100));
}

export function MonthlyFlowCard({
  data,
  monthLabel,
  period,
  isFuture = false,
}: {
  data: MonthlyFlow;
  monthLabel: string;
  period?: FinancialPeriod;
  isFuture?: boolean;
}) {
  if (isFuture) {
    return (
      <article className="card-paper paper-rise-1 flex h-full flex-col gap-2 p-6">
        <div className="text-eyebrow">Flujo · {monthLabel}</div>
        <div className="text-ink-muted mt-2 text-base">Sin datos todavía</div>
        <div className="text-ink-subtle text-xs">Este mes aún no ocurrió.</div>
      </article>
    );
  }

  const positive = data.netCopCents >= BigInt(0);
  const total = data.incomeCopCents + data.expenseCopCents;
  const incomePct = pctOf(data.incomeCopCents, total);
  const dateRange = period ? formatPeriodDateRange(period) : null;
  const fallbackNote = period ? periodFallbackNote(period) : null;

  return (
    <article className="card-paper paper-rise-1 flex h-full flex-col gap-4 p-6">
      <div className="flex flex-col items-end gap-0.5 sm:flex-row sm:items-baseline sm:justify-between">
        <span className="text-eyebrow self-start">Flujo del mes</span>
        <div className="flex flex-col items-end">
          <span className="text-ink-subtle text-xs capitalize">
            {monthLabel}
            {dateRange ? <span className="lowercase"> · {dateRange}</span> : null}
          </span>
          {fallbackNote ? (
            <span className="text-ink-subtle/80 text-[10px]">{fallbackNote}</span>
          ) : null}
        </div>
      </div>

      <div className="flex items-baseline gap-2">
        <span
          className={cn("money-hero text-4xl", positive ? "text-botanical-fg" : "text-ink")}
          aria-label={positive ? "Mes positivo" : "Mes negativo"}
        >
          {positive ? "↗" : "↘"}
        </span>
        <span className="money-hero text-ink text-4xl">
          <AnimatedMoney cents={data.netCopCents} currency="COP" signDisplay="always" />
        </span>
      </div>

      <div className="meter-track flex h-1 overflow-hidden">
        <div
          className="bg-botanical-fg h-full transition-[width] duration-700"
          style={{ width: `${incomePct}%` }}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 pt-1 text-xs">
        <div className="flex flex-col gap-0.5">
          <span className="text-ink-subtle inline-flex items-center gap-1 tracking-wider uppercase">
            <span className="text-botanical-fg">↗</span> Ingreso
          </span>
          <div className="money-hero text-ink text-base">
            <AnimatedMoney cents={data.incomeCopCents} currency="COP" />
          </div>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-ink-subtle inline-flex items-center gap-1 tracking-wider uppercase">
            <span className="text-ink-muted">↘</span> Gasto
          </span>
          <div className="money-hero text-ink text-base">
            <AnimatedMoney cents={data.expenseCopCents} currency="COP" />
          </div>
        </div>
      </div>
    </article>
  );
}
