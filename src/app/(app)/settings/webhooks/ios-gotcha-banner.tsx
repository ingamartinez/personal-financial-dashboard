import { AlertTriangleIcon } from "lucide-react";

const RULES = [
  {
    icon: "❌",
    title: "No guardes “Bancolombia” como contacto",
    why: "iOS ignora los SMS de contactos en el trigger de automation — perdés la captura.",
  },
  {
    icon: "❌",
    title: "No respondas los SMS del banco",
    why: "Abrir o responder el hilo rompe el patrón de Apple para captura nativa (relevante para la app iOS futura).",
  },
  {
    icon: "✅",
    title: "Dejá “Run Immediately” activado",
    why: "Sin esto, iOS pide confirmación cada vez que llega un SMS y la captura falla en la práctica.",
  },
];

export function IosGotchaBanner() {
  return (
    <aside
      role="note"
      aria-label="Atajos de iOS — reglas importantes"
      className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50/60 p-4 dark:border-amber-900/40 dark:bg-amber-950/20"
    >
      <header className="flex items-center gap-2">
        <AlertTriangleIcon className="size-4 text-amber-700 dark:text-amber-300" />
        <h2 className="text-sm font-semibold tracking-tight text-amber-900 dark:text-amber-100">
          Antes de configurar — 3 reglas que no podés olvidar
        </h2>
      </header>
      <ul className="flex flex-col gap-2 text-sm">
        {RULES.map((r) => (
          <li key={r.title} className="flex gap-2">
            <span aria-hidden className="shrink-0 select-none">
              {r.icon}
            </span>
            <div className="flex flex-col">
              <span className="font-medium text-amber-900 dark:text-amber-100">{r.title}</span>
              <span className="text-xs text-amber-900/70 dark:text-amber-100/70">{r.why}</span>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
