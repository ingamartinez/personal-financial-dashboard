import { getSessionUser } from "@/lib/auth/session";
import { getUiPreferences } from "@/lib/preferences/repo";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { getRecurringExpenses } from "./queries";
import { RecurringCalculator } from "@/components/recurring/recurring-calculator";

export const dynamic = "force-dynamic";

export default async function RecurringPage() {
  const session = await getSessionUser();

  const [prefs, fx] = await Promise.all([getUiPreferences(session.id), getCurrentFxRate()]);

  const { rows, monthlyTotals, annualTotals } = await getRecurringExpenses(
    session.id,
    prefs.displayCurrencyMode,
    fx.rate,
  );

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Recurrentes</h1>
        <p className="text-body text-muted-foreground">
          Todos los gastos fijos mensuales activos: lo que sabés que va a salir, sin importar la
          categoría. Gestionálos en{" "}
          <a href="/settings/recurring" className="underline underline-offset-4">
            Settings → Recurring
          </a>
          .
        </p>
      </header>

      <RecurringCalculator rows={rows} monthlyTotals={monthlyTotals} annualTotals={annualTotals} />
    </main>
  );
}
