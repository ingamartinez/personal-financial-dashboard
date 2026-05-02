import { getSessionUser } from "@/lib/auth/session";
import { getUiPreferences } from "@/lib/preferences/repo";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { getSubscriptions } from "./queries";
import { SubscriptionsCalculator } from "@/components/subscriptions/subscriptions-calculator";

export const dynamic = "force-dynamic";

export default async function SubscriptionsPage() {
  const session = await getSessionUser();

  const [prefs, fx] = await Promise.all([getUiPreferences(session.id), getCurrentFxRate()]);

  const { rows, monthlyTotals, annualTotals } = await getSubscriptions(
    session.id,
    prefs.displayCurrencyMode,
    fx.rate,
  );

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Subscriptions</h1>
        <p className="text-body text-muted-foreground">
          Active recurring subscriptions — all items categorised as <em>suscripciones</em>. Monthly
          and annual cost at current display currency. Manage them in{" "}
          <a href="/settings/recurring" className="underline underline-offset-4">
            Settings → Recurring
          </a>
          .
        </p>
      </header>

      <SubscriptionsCalculator
        rows={rows}
        monthlyTotals={monthlyTotals}
        annualTotals={annualTotals}
      />
    </main>
  );
}
