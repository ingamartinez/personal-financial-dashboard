"use client";

import { useState, useTransition } from "react";
import { WalletIcon } from "lucide-react";
import { toast } from "sonner";
import { setCounterpartyIsSalary } from "@/lib/preferences/actions";
import { Money } from "@/components/display/money";
import type { SalaryCandidate } from "@/lib/dashboard/period";

export function SalaryCandidatesList({ candidates }: { candidates: SalaryCandidate[] }) {
  // Optimistic local mirror — toggling each row is independent, so we keep
  // the user's view responsive while the server action revalidates the page.
  const [optimistic, setOptimistic] = useState<Record<number, boolean>>(
    Object.fromEntries(candidates.map((c) => [c.id, c.isSalary])),
  );
  const [pending, startTransition] = useTransition();

  function toggle(id: number, next: boolean) {
    const previous = optimistic[id];
    setOptimistic((s) => ({ ...s, [id]: next }));
    startTransition(async () => {
      try {
        await setCounterpartyIsSalary({ counterpartyId: id, isSalary: next });
      } catch (err) {
        // Revert on failure so the UI stays truthful.
        setOptimistic((s) => ({ ...s, [id]: previous }));
        toast.error(err instanceof Error ? err.message : "No se pudo guardar");
      }
    });
  }

  if (candidates.length === 0) {
    return (
      <section className="card-paper paper-rise-1 flex flex-col gap-2 p-5">
        <span className="text-eyebrow">Sueldos</span>
        <p className="text-ink-muted text-sm">
          Aún no recibiste pagos en Findash. Cuando entren los primeros ingresos vas a poder
          marcarlos como sueldo acá.
        </p>
      </section>
    );
  }

  return (
    <section className="card-paper paper-rise-1 flex flex-col gap-3 p-5">
      <div className="flex flex-col gap-0.5">
        <span className="text-eyebrow">Sueldos</span>
        <p className="text-ink-muted text-xs">
          Marcá la(s) fuente(s) de ingreso fijo. Findash usa los pagos detectados para anclar el
          período financiero. Listamos solo los counterparties con ingresos registrados.
        </p>
      </div>

      <ul className="flex flex-col divide-y">
        {candidates.map((c) => {
          const checked = optimistic[c.id] ?? false;
          return (
            <li key={c.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="flex min-w-0 flex-col">
                <span className="text-ink truncate text-sm font-medium">{c.displayName}</span>
                <span className="text-ink-muted text-xs">
                  {c.incomeTxCount} ingreso{c.incomeTxCount === 1 ? "" : "s"} · total{" "}
                  <Money cents={c.totalIncomeCents} currency="COP" />
                </span>
              </div>
              <button
                type="button"
                onClick={() => toggle(c.id, !checked)}
                disabled={pending}
                aria-pressed={checked}
                aria-label={
                  checked
                    ? `Desmarcar ${c.displayName} como sueldo`
                    : `Marcar ${c.displayName} como sueldo`
                }
                className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                  checked
                    ? "border-primary bg-primary/10 text-foreground"
                    : "bg-background text-muted-foreground hover:bg-muted"
                }`}
              >
                <WalletIcon className="size-3" />
                <span>{checked ? "Sueldo" : "Marcar sueldo"}</span>
                <span
                  className={`relative inline-flex h-3 w-6 shrink-0 items-center rounded-full transition-colors ${
                    checked ? "bg-primary" : "bg-muted-foreground/30"
                  }`}
                  aria-hidden
                >
                  <span
                    className={`bg-background inline-block size-2.5 rounded-full transition-transform ${
                      checked ? "translate-x-3" : "translate-x-0.5"
                    }`}
                  />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
