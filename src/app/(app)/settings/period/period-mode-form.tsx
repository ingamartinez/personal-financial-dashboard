"use client";

import { useTransition } from "react";
import { CalendarIcon, WalletIcon } from "lucide-react";
import { toast } from "sonner";
import { setFinancialCycleMode } from "@/lib/preferences/actions";
import type { FinancialCycleMode } from "@/lib/db/schema";

export function PeriodModeForm({
  currentMode,
  ready,
}: {
  currentMode: FinancialCycleMode;
  ready: boolean;
}) {
  const [pending, startTransition] = useTransition();

  function pick(mode: FinancialCycleMode) {
    if (mode === currentMode) return;
    if (mode === "pay_period" && !ready) return;
    startTransition(async () => {
      try {
        await setFinancialCycleMode(mode);
        toast.success(
          mode === "pay_period" ? "Modo sueldo activado" : "Modo mes calendario activado",
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "No se pudo cambiar el modo");
      }
    });
  }

  return (
    <section className="card-paper paper-rise-1 flex flex-col gap-3 p-5">
      <div className="flex flex-col gap-0.5">
        <span className="text-eyebrow">Modo de ciclo financiero</span>
        <p className="text-ink-muted text-xs">
          Cómo se calculan los bordes del mes en el dashboard, presupuestos e insights.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <ModeOption
          active={currentMode === "calendar"}
          disabled={pending}
          icon={<CalendarIcon className="size-4" />}
          title="Mes calendario"
          description="Del 1 al fin de mes. Comportamiento por defecto."
          onClick={() => pick("calendar")}
        />
        <ModeOption
          active={currentMode === "pay_period"}
          disabled={pending || !ready}
          icon={<WalletIcon className="size-4" />}
          title="Anclado en mi sueldo"
          description={
            ready
              ? "El mes va de un pago al siguiente. Recomendado si cobrás regular."
              : "Marcá tu sueldo y registrá al menos 2 pagos para activar este modo."
          }
          onClick={() => pick("pay_period")}
        />
      </div>
    </section>
  );
}

function ModeOption({
  active,
  disabled,
  icon,
  title,
  description,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`flex flex-col items-start gap-1.5 rounded-md border p-4 text-left transition-colors ${
        active ? "border-primary bg-primary/5" : "bg-background hover:bg-muted/40 border-border"
      } ${disabled && !active ? "cursor-not-allowed opacity-60" : ""}`}
    >
      <span className="text-ink flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
        {active ? (
          <span className="text-primary text-[10px] tracking-wider uppercase">activo</span>
        ) : null}
      </span>
      <span className="text-ink-muted text-xs leading-snug">{description}</span>
    </button>
  );
}
