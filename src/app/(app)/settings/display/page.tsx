import { getSessionUser } from "@/lib/auth/session";
import { getUiPreferences } from "@/lib/preferences/repo";
import { DisplayCurrencyForm } from "./display-currency-form";

export const dynamic = "force-dynamic";

export default async function DisplaySettingsPage() {
  const session = await getSessionUser();
  const prefs = await getUiPreferences(session.id);

  return (
    <main
      id="moneda-visualizacion"
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6"
    >
      <header>
        <h1 className="text-h1">Moneda de visualización</h1>
        <p className="text-body text-muted-foreground">
          Elegí cómo se muestran los montos en el dashboard, transacciones, presupuestos e insights.
          En modo nativo cada cuenta muestra su propia moneda. En COP o USD todos los montos se
          convierten usando la TRM histórica de cada transacción.
        </p>
      </header>

      <DisplayCurrencyForm currentMode={prefs.displayCurrencyMode} />

      <section className="card-paper paper-rise-1 flex flex-col gap-1 p-4 text-sm">
        <span className="text-eyebrow">Sobre la TRM histórica</span>
        <p className="text-ink-muted text-xs leading-relaxed">
          Cuando convertís a COP o USD, se usa la TRM que estaba vigente al momento de cada
          transacción (congelada en el extracto o el email de confirmación), no la de hoy. Esto
          evita que los reportes históricos cambien cuando cambia el tipo de cambio.
        </p>
        <p className="text-ink-muted mt-1 text-xs leading-relaxed">
          Las transacciones sin TRM histórica disponible se muestran en su moneda original con un
          indicador de conversión pendiente.
        </p>
      </section>
    </main>
  );
}
