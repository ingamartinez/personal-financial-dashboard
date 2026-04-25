import { getSessionUser } from "@/lib/auth/session";
import { getUiPreferences } from "@/lib/preferences/repo";
import {
  formatPeriodDateRange,
  getFinancialPeriod,
  getPayPeriodReadiness,
  listSalaryCandidates,
} from "@/lib/dashboard/period";
import { PeriodModeForm } from "./period-mode-form";
import { SalaryCandidatesList } from "./salary-candidates-list";

export const dynamic = "force-dynamic";

export default async function PeriodSettingsPage() {
  const session = await getSessionUser();
  const [prefs, readiness, candidates, period] = await Promise.all([
    getUiPreferences(session.id),
    getPayPeriodReadiness(session.id),
    listSalaryCandidates(session.id),
    // Always resolve so we can preview the current period when the mode is
    // active. When mode = "calendar" the helper returns the calendar range;
    // we hide the preview in that case.
    getFinancialPeriod(session.id),
  ]);

  const dateRange = formatPeriodDateRange(period);
  const showPreview = prefs.financialCycleMode === "pay_period" && dateRange !== null;

  return (
    <main
      id="periodo-financiero"
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6"
    >
      <header>
        <h1 className="text-h1">Período financiero</h1>
        <p className="text-body text-muted-foreground">
          Por defecto, Findash usa el mes calendario para el flujo, los presupuestos y los insights.
          Si cobrás un sueldo regular, podés anclar el período en tus fechas reales de pago para que
          el flujo del mes refleje tu ciclo, no el del banco.
        </p>
      </header>

      <PeriodModeForm currentMode={prefs.financialCycleMode} ready={readiness.ready} />

      <SalaryCandidatesList candidates={candidates} />

      {showPreview ? (
        <section className="card-paper paper-rise-1 flex flex-col gap-1 p-4 text-sm">
          <span className="text-eyebrow">Tu período actual</span>
          <p className="text-ink">
            <span className="lowercase">{dateRange}</span>
          </p>
          <p className="text-ink-muted text-xs">
            El flujo del mes, los presupuestos y los insights agregan transacciones dentro de este
            rango. Las cuotas de TC y el próximo pago siguen el calendario del banco.
          </p>
        </section>
      ) : null}
    </main>
  );
}
