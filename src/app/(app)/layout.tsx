import { Header } from "@/components/layout/header";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { QuickExpenseFab } from "@/components/transactions/quick-expense-fab";
import { LiveRefresh } from "@/components/live-refresh";

export default function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <>
      <Header />
      <Breadcrumbs />
      <div className="flex flex-1 flex-col">{children}</div>
      <QuickExpenseFab />
      <LiveRefresh />
    </>
  );
}
