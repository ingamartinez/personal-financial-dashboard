import {
  getAccountStatuses,
  getCategoryBreakdown,
  getMonthlyFlow,
  getNetWorth,
  getTopExpenses,
} from "@/lib/dashboard/queries";
import { NetWorthCard } from "@/components/dashboard/net-worth-card";
import { MonthlyFlowCard } from "@/components/dashboard/monthly-flow-card";
import { CategoryDonut } from "@/components/dashboard/category-donut";
import { TopExpensesCard } from "@/components/dashboard/top-expenses-card";
import { AccountsGrid } from "@/components/dashboard/accounts-grid";
import { UpcomingCard } from "@/components/dashboard/upcoming-card";
import { getUpcomingForMonth } from "@/lib/recurring/upcoming";

export const dynamic = "force-dynamic";

const monthFmt = new Intl.DateTimeFormat("es-CO", { month: "long", year: "numeric" });

export default async function DashboardPage() {
  const now = new Date();
  const monthLabel = monthFmt.format(now);

  const [netWorth, flow, slices, top, accounts, upcoming] = await Promise.all([
    getNetWorth(),
    getMonthlyFlow(now),
    getCategoryBreakdown(now),
    getTopExpenses(now, 5),
    getAccountStatuses(),
    getUpcomingForMonth({
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      includeDismissed: true,
      today: now,
    }),
  ]);

  const upcomingItems = upcoming.map((u) => ({
    ...u,
    amountCents: u.amountCents.toString(),
  }));

  const donutSlices = slices.map((s) => ({
    slug: s.slug,
    name: s.name,
    color: s.color,
    value: Number(s.amountCopCents),
  }));

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground capitalize">{monthLabel}</p>
      </header>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <NetWorthCard data={netWorth} />
        <MonthlyFlowCard data={flow} monthLabel={monthLabel} />
        <CategoryDonut slices={donutSlices} monthLabel={monthLabel} />
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TopExpensesCard rows={top} monthLabel={monthLabel} />
        <UpcomingCard items={upcomingItems} monthLabel={monthLabel} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Accounts</h2>
        <AccountsGrid accounts={accounts} />
      </section>
    </main>
  );
}
