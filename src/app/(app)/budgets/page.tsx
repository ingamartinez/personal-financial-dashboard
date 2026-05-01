import { getSessionUser } from "@/lib/auth/session";
import { getBudgetsOverview } from "@/lib/budgets/queries";
import { getFinancialPeriod } from "@/lib/dashboard/period";
import { getUiPreferences } from "@/lib/preferences/repo";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { BudgetsManager } from "./budgets-manager";

export const dynamic = "force-dynamic";

function currentYearMonth(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string }>;
}) {
  const session = await getSessionUser();
  const params = await searchParams;
  const ym = params.ym && /^\d{4}-\d{2}$/.test(params.ym) ? params.ym : currentYearMonth();

  // #493: budget plans stay calendar-anchored (a budget is "April 2026"),
  // but spend aggregation respects the user's financial cycle so the bar
  // matches the dashboard's "Flujo del mes". Bank-truth views (cuotas,
  // statements) are NOT in scope here.
  const [y, m] = ym.split("-").map(Number);
  const refDate = new Date(Date.UTC(y, m - 1, 15));
  const [period, prefs, fx] = await Promise.all([
    getFinancialPeriod(session.id, refDate),
    getUiPreferences(session.id),
    getCurrentFxRate(),
  ]);

  const { categories: cats, items } = await getBudgetsOverview(
    session.id,
    ym,
    { start: period.start, end: period.end },
    { displayCurrencyMode: prefs.displayCurrencyMode, copPerUsd: fx.rate },
  );

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Budgets</h1>
        <p className="text-body text-muted-foreground">
          Monthly spending caps per category. Each month starts fresh — no rollover. Progress tracks
          expenses (negative transactions) in the selected month.
        </p>
      </header>
      <BudgetsManager ym={ym} categories={cats} items={items} />
    </main>
  );
}
