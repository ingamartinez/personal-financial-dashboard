import Link from "next/link";
import { Money } from "@/components/display/money";
import { cn } from "@/lib/utils";
import type { CreditCardsSummary } from "@/lib/dashboard/queries";

const NEXT_PAYMENT_FMT = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "short",
});

function formatNextPayment(isoDate: string): string {
  return NEXT_PAYMENT_FMT.format(new Date(`${isoDate}T12:00:00Z`));
}

function formatDaysUntil(days: number): string {
  if (days <= 0) return "hoy";
  if (days === 1) return "mañana";
  return `en ${days} días`;
}

export function CreditCardsCard({ data }: { data: CreditCardsSummary }) {
  if (data.cardCount === 0) return null;
  const showMeter = data.limitCopCents > BigInt(0);
  const usedPctLabel = `${Math.round(data.usedPct)}%`;
  const heavyUse = data.usedPct >= 80;
  const cardWord = data.cardCount === 1 ? "tarjeta" : "tarjetas";

  return (
    <article className="card-paper paper-rise-2 p-7 sm:p-8">
      <header className="border-rule flex items-center justify-between gap-2 border-b pb-5">
        <div className="flex items-baseline gap-3">
          <span className="text-eyebrow">Crédito disponible</span>
          <span className="text-ink-subtle text-xs">
            · {data.cardCount} {cardWord}
          </span>
        </div>
        <Link
          href="/accounts"
          className="text-ink-muted hover:text-ink text-xs underline-offset-4 hover:underline"
        >
          Ver detalle →
        </Link>
      </header>

      <div className="grid grid-cols-1 gap-7 pt-6 sm:grid-cols-3 sm:gap-5">
        <section className="flex flex-col gap-2">
          <span className="text-ink-subtle text-[11px] tracking-wider uppercase">
            Cupo disponible
          </span>
          {showMeter ? (
            <>
              <div className="money-hero text-botanical-fg text-3xl">
                <Money cents={data.availableCopCents} currency="COP" />
              </div>
              <div className="meter-track mt-1 h-1.5">
                <div
                  className={cn(heavyUse ? "meter-fill-amber" : "meter-fill")}
                  style={{ width: `${data.usedPct}%` }}
                />
              </div>
              <div className="text-ink-subtle text-[11px] tabular-nums">
                Usaste {usedPctLabel} de <Money cents={data.limitCopCents} currency="COP" />
              </div>
            </>
          ) : (
            <div className="text-ink-subtle text-base">—</div>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <span className="text-ink-subtle text-[11px] tracking-wider uppercase">Próximo pago</span>
          {data.nextPayment ? (
            <>
              <div className="money-hero text-ink text-3xl">
                {formatNextPayment(data.nextPayment.date)}
              </div>
              <div className="text-ink-muted text-xs">
                {formatDaysUntil(data.nextPayment.daysUntil)}
              </div>
            </>
          ) : (
            <div className="text-ink-subtle text-base">—</div>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <span className="text-ink-subtle text-[11px] tracking-wider uppercase">Deuda actual</span>
          <div className="money-hero text-ink-muted text-2xl">
            <Money cents={data.debtCopCents} currency="COP" />
          </div>
          <div className="text-ink-subtle text-[11px]">A pagar el próximo ciclo</div>
        </section>
      </div>
    </article>
  );
}
