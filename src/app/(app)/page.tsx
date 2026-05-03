import {
  getCategoryBreakdown,
  getCreditCardsSummary,
  getFinancialPicture,
  getMonthlyFlow,
  getMonthlyProgress,
  getTopExpenses,
} from "@/lib/dashboard/queries";
import { listAccountsDetailed } from "@/lib/accounts/queries";
import { getFinancialPeriod, getPayPeriodReadiness } from "@/lib/dashboard/period";
import { getUiPreferences } from "@/lib/preferences/repo";
import { SaldoLiquidoCard } from "@/components/dashboard/saldo-liquido-card";
import { MonthlyFlowCard } from "@/components/dashboard/monthly-flow-card";
import { ProgressCard } from "@/components/dashboard/progress-card";
import { CategoryDonut } from "@/components/dashboard/category-donut";
import { TopExpensesCard } from "@/components/dashboard/top-expenses-card";
import { AccountsGrid } from "@/components/dashboard/accounts-grid";
import { UpcomingCard } from "@/components/dashboard/upcoming-card";
import { MonthSwitcher } from "@/components/dashboard/month-switcher";
import { RecurringPendingBanner } from "@/components/dashboard/recurring-pending-banner";
import { RecurringProposalsBanner } from "@/components/dashboard/recurring-proposals-banner";
import { SmsHealthCard } from "@/components/dashboard/sms-health-card";
import { CreditCardsCard } from "@/components/dashboard/credit-cards-card";
import { PendingConsolidationBanner } from "@/components/dashboard/pending-consolidation-banner";
import { PayPeriodNudge } from "@/components/dashboard/pay-period-nudge";
import { getUpcomingForWindow } from "@/lib/recurring/upcoming";
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
  const session = await getSessionUser();
  const fx = await getCurrentFxRate();

  // Resolve the financial period ONCE and pass it to every month-bound
  // query — this guarantees all dashboard cards aggregate over the same
  // boundaries (calendar OR salary-anchored). Fallback semantics live in
  // the `mode`/`fallbackReason` fields so cards can render the right
  // subtitle and inline notes. See #493 + src/lib/dashboard/period.ts.
  const period = await getFinancialPeriod(session.id, refDate);
  const range = { start: period.start, end: period.end };

  const [prefs, readiness] = await Promise.all([
    getUiPreferences(session.id),
    getPayPeriodReadiness(session.id),
  ]);
  // Show the dashboard nudge when the user is eligible for pay_period mode
  // (≥1 salary flag + ≥2 paychecks) but still on calendar AND has not
  // dismissed the banner before. One-shot opt-in surface.
  const showPayPeriodNudge =
    prefs.financialCycleMode === "calendar" && readiness.ready && !prefs.payPeriodNudgeDismissed;

  const [picture, flow, progress, slices, top, accounts, upcoming, smsHealth, creditCards] =
    await Promise.all([
      getFinancialPicture(session.id, fx.rate),
      getMonthlyFlow(session.id, fx.rate, range),
      getMonthlyProgress(session.id, fx.rate, range),
      getCategoryBreakdown(session.id, fx.rate, range),
      getTopExpenses(session.id, fx.rate, range, 5),
      listAccountsDetailed(session.id),
      // #632: window-based query (today ±5d, cross-month, un-matched only).
      getUpcomingForWindow({ userId: session.id, today: now }),
      getSmsHealthSnapshot(session.id, now),
      // Bank truth — TC summary stays on calendar regardless of cycle mode.
      getCreditCardsSummary(session.id, fx.rate, now),
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
    <main className="surface-paper-grain min-h-screen">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-7 p-4 sm:p-6 lg:gap-9 lg:p-10">
        <header className="paper-rise flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-eyebrow">Findash</span>
            <h1 className="text-display text-ink text-4xl font-semibold sm:text-5xl">
              Tu mes en una hoja
            </h1>
            <p className="text-ink-muted text-sm capitalize">{monthLabel}</p>
          </div>
          <MonthSwitcher ym={ym} />
        </header>

        <PendingConsolidationBanner userId={session.id} />

        {showPayPeriodNudge ? <PayPeriodNudge /> : null}

        <section>
          <SaldoLiquidoCard data={picture} fx={fx} monthLabel={monthLabel} />
        </section>

        <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <MonthlyFlowCard
            data={flow}
            monthLabel={monthLabel}
            period={period}
            isFuture={isFuture}
          />
          <ProgressCard
            data={progress}
            monthLabel={monthLabel}
            period={period}
            isFuture={isFuture}
          />
        </section>

        {creditCards.cardCount > 0 ? (
          <section>
            <CreditCardsCard data={creditCards} />
          </section>
        ) : null}

        <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <TopExpensesCard
            rows={top}
            monthLabel={monthLabel}
            ym={ym}
            period={period}
            isFuture={isFuture}
          />
          <UpcomingCard items={upcomingItems} windowLabel="±5d desde hoy" />
        </section>

        <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <CategoryDonut
            slices={donutSlices}
            monthLabel={monthLabel}
            period={period}
            isFuture={isFuture}
          />
          <SmsHealthCard snapshot={smsHealth} />
        </section>

        <RecurringPendingBanner userId={session.id} />

        <RecurringProposalsBanner />

        <section className="flex flex-col gap-4">
          <h2 className="text-eyebrow">Cuentas</h2>
          <AccountsGrid accounts={accounts} copPerUsd={fx.rate} />
        </section>
      </div>
    </main>
  );
}
