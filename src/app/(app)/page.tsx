import {
  getAccountStatuses,
  getCategoryBreakdown,
  getCreditCardsSummary,
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
import { MonthSwitcher } from "@/components/dashboard/month-switcher";
import { RecurringInboxCard } from "@/components/dashboard/recurring-inbox-card";
import { SmsHealthCard } from "@/components/dashboard/sms-health-card";
import { CreditCardsCard } from "@/components/dashboard/credit-cards-card";
import { getUpcomingForMonth } from "@/lib/recurring/upcoming";
import { getOpenGaps } from "@/lib/recurring/gap-queries";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { getSmsHealthSnapshot } from "@/lib/ingestion/sms-health";
import { getSessionUser } from "@/lib/auth/session";
import {
  formatYearMonth,
  isFutureYearMonth,
  parseYearMonthOrCurrent,
  refDateFromYearMonth,
} from "@/lib/date/year-month";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string }>;
}) {
  const params = await searchParams;
  const now = new Date();
  const ym = parseYearMonthOrCurrent(params.ym, now);
  const refDate = refDateFromYearMonth(ym);
  const isFuture = isFutureYearMonth(ym, now);
  const monthLabel = formatYearMonth(ym);
  const [refYear, refMonth] = ym.split("-").map(Number);

  const session = await getSessionUser();
  const fx = await getCurrentFxRate();
  const [netWorth, flow, slices, top, accounts, upcoming, openGaps, smsHealth, creditCards] =
    await Promise.all([
      getNetWorth(session.id, fx.rate),
      getMonthlyFlow(session.id, fx.rate, refDate),
      getCategoryBreakdown(session.id, fx.rate, refDate),
      getTopExpenses(session.id, fx.rate, refDate, 5),
      getAccountStatuses(session.id),
      getUpcomingForMonth({
        userId: session.id,
        year: refYear,
        month: refMonth,
        includeDismissed: true,
        today: now,
      }),
      getOpenGaps(session.id),
      getSmsHealthSnapshot(session.id, now),
      getCreditCardsSummary(session.id, fx.rate, now),
    ]);

  const upcomingItems = upcoming.map((u) => ({
    ...u,
    amountCents: u.amountCents.toString(),
  }));

  const gapItems = openGaps.map((g) => ({
    gapId: g.gapId,
    recurringId: g.recurringId,
    yearMonth: g.yearMonth,
    label: g.label,
    accountName: g.accountName,
    amountCents: g.amountCents.toString(),
    currency: g.currency,
    categoryName: g.categoryName,
    dayOfMonth: g.dayOfMonth,
  }));

  const donutSlices = slices.map((s) => ({
    slug: s.slug,
    name: s.name,
    color: s.color,
    value: Number(s.amountCopCents),
  }));

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-h1">Dashboard</h1>
          <p className="text-body text-muted-foreground capitalize">{monthLabel}</p>
        </div>
        <MonthSwitcher ym={ym} />
      </header>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <NetWorthCard data={netWorth} fx={fx} />
        <MonthlyFlowCard data={flow} monthLabel={monthLabel} isFuture={isFuture} />
        <CategoryDonut slices={donutSlices} monthLabel={monthLabel} isFuture={isFuture} />
        <SmsHealthCard snapshot={smsHealth} />
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TopExpensesCard rows={top} monthLabel={monthLabel} ym={ym} isFuture={isFuture} />
        <UpcomingCard items={upcomingItems} monthLabel={monthLabel} />
      </section>

      {gapItems.length > 0 ? (
        <section>
          <RecurringInboxCard gaps={gapItems} />
        </section>
      ) : null}

      {creditCards.cardCount > 0 ? (
        <section>
          <CreditCardsCard data={creditCards} />
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-h2">Accounts</h2>
        <AccountsGrid accounts={accounts} />
      </section>
    </main>
  );
}
