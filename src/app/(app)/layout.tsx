import { Header } from "@/components/layout/header";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { MoneyModeProvider } from "@/components/display/money-mode-provider";
import { QuickExpenseFab } from "@/components/transactions/quick-expense-fab";
import { LiveRefresh } from "@/components/live-refresh";
import { getSessionUserOrNull } from "@/lib/auth/session";
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

  // Currency display toggle: mode + fxRate will be wired in a follow-up; for
  // now the provider runs in `native` mode with no rate → conversion is a
  // no-op and every Money render matches the pre-toggle behavior.
  return (
    <MoneyModeProvider mode={DEFAULT_DISPLAY_CURRENCY_MODE} fxRate={null}>
      <Header user={headerUser} />
      <Breadcrumbs />
      <div className="flex flex-1 flex-col">{children}</div>
      <QuickExpenseFab />
      <LiveRefresh />
    </MoneyModeProvider>
  );
}
