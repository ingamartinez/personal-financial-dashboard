import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { insightsReports } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/auth/session";
import { buildInsightsSummary, hashSummary, isStale } from "@/lib/ai/insights";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { getFinancialPeriod } from "@/lib/dashboard/period";
import { InsightsViewer } from "./insights-viewer";

export const dynamic = "force-dynamic";

function currentYearMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string }>;
}) {
  const params = await searchParams;
  const ym = params.ym && /^\d{4}-\d{2}$/.test(params.ym) ? params.ym : currentYearMonth();

  const session = await getSessionUser();
  const fx = await getCurrentFxRate();
  // Resolve current AND previous financial periods so the month-over-month
  // comparison stays apples-to-apples (both salary-anchored if pay_period
  // mode is on, both calendar otherwise).
  const [y, m] = ym.split("-").map(Number);
  const [currentPeriod, previousPeriod] = await Promise.all([
    getFinancialPeriod(session.id, new Date(Date.UTC(y, m - 1, 15))),
    getFinancialPeriod(session.id, new Date(Date.UTC(y, m - 2, 15))),
  ]);
  const summary = await buildInsightsSummary(session.id, ym, fx.rate, undefined, {
    currentRange: { start: currentPeriod.start, end: currentPeriod.end },
    previousRange: { start: previousPeriod.start, end: previousPeriod.end },
  });
  const currentHash = hashSummary(summary);

  const [existing] = await db
    .select()
    .from(insightsReports)
    .where(and(eq(insightsReports.userId, session.id), eq(insightsReports.yearMonth, ym)))
    .limit(1);

  const stale = existing ? isStale(existing.generatedAt, existing.inputHash, currentHash) : true;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Insights</h1>
        <p className="text-body text-muted-foreground">
          Reporte mensual generado con Claude Sonnet. Se regenera si pasaron 24h o aparecieron
          nuevas transacciones en el mes.
        </p>
      </header>
      <InsightsViewer
        ym={ym}
        summary={{
          incomeCop: summary.totals.incomeCop,
          expenseCop: summary.totals.expenseCop,
          netCop: summary.totals.netCop,
          previousNetCop: summary.totals.previousNetCop,
          txCount: summary.categoriesCurrent.reduce((a, c) => a + c.txCount, 0),
          categoryCount: summary.categoriesCurrent.length,
        }}
        report={
          existing
            ? {
                markdown: existing.markdown,
                generatedAt: existing.generatedAt.toISOString(),
                model: existing.model,
                inputTokens: existing.inputTokens,
                outputTokens: existing.outputTokens,
                stale,
              }
            : null
        }
      />
    </main>
  );
}
