import { getSessionUser } from "@/lib/auth/session";
import { getUiPreferences } from "@/lib/preferences/repo";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { getRecurringExpenses } from "./queries";
import { getUpcomingForMonth, type UpcomingStatus } from "@/lib/recurring/upcoming";
import { RecurringCalculator } from "@/components/recurring/recurring-calculator";

export const dynamic = "force-dynamic";

export default async function RecurringPage() {
  const session = await getSessionUser();

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  const [prefs, fx, upcomingItems] = await Promise.all([
    getUiPreferences(session.id),
    getCurrentFxRate(),
    getUpcomingForMonth({ userId: session.id, year, month, includeMatched: true }),
  ]);

  const { rows, monthlyTotals, annualTotals } = await getRecurringExpenses(
    session.id,
    prefs.displayCurrencyMode,
    fx.rate,
  );

  // Build a plain JSON-serializable Record (not a Map) for RSC prop boundary.
  const slotStatusByRecurringId: Record<number, UpcomingStatus> = {};
  for (const item of upcomingItems) {
    slotStatusByRecurringId[item.recurringId] = item.status;
  }

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

      <RecurringCalculator
        rows={rows}
        monthlyTotals={monthlyTotals}
        annualTotals={annualTotals}
        slotStatusByRecurringId={slotStatusByRecurringId}
      />
    </main>
  );
}
