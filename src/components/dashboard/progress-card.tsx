import { AnimatedMoney } from "@/components/ui/animated-money";
import type { MonthlyProgress } from "@/lib/dashboard/queries";

export function ProgressCard({
  data,
  monthLabel,
  isFuture = false,
}: {
  data: MonthlyProgress;
  monthLabel: string;
  isFuture?: boolean;
}) {
  if (isFuture) {
    return null;
  }

  if (!data.hasAny) {
    return (
      <article className="card-paper paper-rise-2 flex h-full flex-col gap-3 p-6">
        <span className="text-eyebrow">Progreso</span>
        <p className="text-ink-muted text-sm leading-relaxed">
          Aún no hay aportes ni pagos a deuda este mes. Lo que registres aparecerá acá.
        </p>
      </article>
    );
  }

  return (
    <article className="card-paper paper-rise-2 flex h-full flex-col gap-5 p-6">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-eyebrow">Progreso</span>
        <span className="text-ink-subtle text-xs capitalize">{monthLabel}</span>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        {data.debtPaidCopCents > BigInt(0) ? (
          <section className="flex flex-col gap-1">
            <span className="text-ink-subtle text-[11px] tracking-wider uppercase">
              Recuperaste cupo
            </span>
            <div className="money-hero text-botanical-fg text-2xl">
              <AnimatedMoney cents={data.debtPaidCopCents} currency="COP" />
            </div>
            <span className="text-ink-muted text-xs">en pagos a tarjetas</span>
          </section>
        ) : (
          <section className="flex flex-col gap-1">
            <span className="text-ink-subtle text-[11px] tracking-wider uppercase">
              Recuperaste cupo
            </span>
            <div className="text-ink-muted text-base">—</div>
            <span className="text-ink-subtle text-xs">Sin pagos a tarjetas aún</span>
          </section>
        )}

        {data.savingsCopCents > BigInt(0) ? (
          <section className="flex flex-col gap-1">
            <span className="text-ink-subtle text-[11px] tracking-wider uppercase">Ahorraste</span>
            <div className="money-hero text-botanical-fg text-2xl">
              <AnimatedMoney cents={data.savingsCopCents} currency="COP" />
            </div>
            <span className="text-ink-muted text-xs">flujo positivo del mes</span>
          </section>
        ) : (
          <section className="flex flex-col gap-1">
            <span className="text-ink-subtle text-[11px] tracking-wider uppercase">Ahorraste</span>
            <div className="text-ink-muted text-base">—</div>
            <span className="text-ink-subtle text-xs">El flujo del mes aún no es positivo</span>
          </section>
        )}
      </div>
    </article>
  );
}
