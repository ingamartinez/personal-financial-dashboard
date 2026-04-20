import { Header } from "@/components/layout/header";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { MoneyModeProvider } from "@/components/display/money-mode-provider";
import { QuickExpenseFab } from "@/components/transactions/quick-expense-fab";
import { LiveRefresh } from "@/components/live-refresh";
import { getSessionUserOrNull } from "@/lib/auth/session";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { getUiPreferences } from "@/lib/preferences/repo";
import { DEFAULT_DISPLAY_CURRENCY_MODE } from "@/lib/db/schema";
import { auth } from "@/auth";

export default async function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const [sessionUser, session] = await Promise.all([getSessionUserOrNull(), auth()]);

  const headerUser = sessionUser
    ? {
        email: sessionUser.email,
        name: sessionUser.name,
        pictureUrl: session?.user?.image ?? null,
      }
    : null;

  // MoneyModeProvider feeds every `<Money>` / `<AnimatedMoney>` in the tree.
  // When the user is unauthenticated we fall back to native mode with no rate
  // so the toggle renders a no-op until login.
  const [prefs, fx] = sessionUser
    ? await Promise.all([getUiPreferences(sessionUser.id), getCurrentFxRate()])
    : [{ displayCurrencyMode: DEFAULT_DISPLAY_CURRENCY_MODE }, null];

  return (
    <MoneyModeProvider
      mode={prefs.displayCurrencyMode}
      fxRate={fx ? { rate: fx.rate, source: fx.source } : null}
    >
      <Header user={headerUser} />
      <Breadcrumbs />
      <div className="flex flex-1 flex-col">{children}</div>
      <QuickExpenseFab />
      <LiveRefresh />
    </MoneyModeProvider>
  );
}
