import { Header } from "@/components/layout/header";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { QuickExpenseFab } from "@/components/transactions/quick-expense-fab";
import { LiveRefresh } from "@/components/live-refresh";
import { getSessionUserOrNull } from "@/lib/auth/session";
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

  return (
    <>
      <Header user={headerUser} />
      <Breadcrumbs />
      <div className="flex flex-1 flex-col">{children}</div>
      <QuickExpenseFab />
      <LiveRefresh />
    </>
  );
}
