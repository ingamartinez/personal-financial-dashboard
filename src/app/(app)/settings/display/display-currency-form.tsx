"use client";

import { useTransition } from "react";
import { DollarSignIcon, CoinsIcon, LayoutGridIcon } from "lucide-react";
import { toast } from "sonner";
import { setDisplayCurrencyMode } from "@/lib/preferences/actions";
import type { DisplayCurrencyMode } from "@/lib/db/schema";

const OPTIONS: {
  mode: DisplayCurrencyMode;
  icon: React.ReactNode;
  title: string;
  description: string;
}[] = [
  {
    mode: "native",
    icon: <LayoutGridIcon className="size-4" />,
    title: "Nativo",
    description: "Cada cuenta muestra su propia moneda. ARQ en USD, Bancolombia en COP.",
  },
  {
    mode: "all-cop",
    icon: <CoinsIcon className="size-4" />,
    title: "Todo en COP",
    description:
      "Convierte USD/USDc a pesos usando la TRM histórica de cada transacción. Ideal para reportes en moneda local.",
  },
  {
    mode: "all-usd",
    icon: <DollarSignIcon className="size-4" />,
    title: "Todo en USD",
    description:
      "Convierte COP a USD usando la TRM histórica de cada transacción. Útil si pensás en dólares.",
  },
];

export function DisplayCurrencyForm({ currentMode }: { currentMode: DisplayCurrencyMode }) {
  const [pending, startTransition] = useTransition();

  function pick(mode: DisplayCurrencyMode) {
    if (mode === currentMode) return;
    startTransition(async () => {
      try {
        await setDisplayCurrencyMode(mode);
        toast.success(
          mode === "native"
            ? "Modo nativo activado"
            : mode === "all-cop"
              ? "Mostrando todo en COP"
              : "Mostrando todo en USD",
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "No se pudo cambiar la moneda");
      }
    });
  }

  return (
    <section className="card-paper paper-rise-1 flex flex-col gap-3 p-5">
      <div className="flex flex-col gap-0.5">
        <span className="text-eyebrow">Moneda de visualización</span>
        <p className="text-ink-muted text-xs">
          Cómo se muestran los montos en todo el dashboard. Usa TRM histórica, no la de hoy.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {OPTIONS.map((opt) => (
          <ModeOption
            key={opt.mode}
            active={currentMode === opt.mode}
            disabled={pending}
            icon={opt.icon}
            title={opt.title}
            description={opt.description}
            onClick={() => pick(opt.mode)}
          />
        ))}
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
