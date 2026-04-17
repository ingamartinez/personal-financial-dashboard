import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { insightsReports } from "@/lib/db/schema";
import { buildInsightsSummary, hashSummary, isStale } from "@/lib/ai/insights";
import { getCurrentFxRate } from "@/lib/fx/repo";
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
  const ym = params.ym && /^\d{4}-\d{2}$/.test(params.ym)
    ? params.ym
    : currentYearMonth();

  const fx = await getCurrentFxRate();
  const summary = await buildInsightsSummary(ym, fx.rate);
  const currentHash = hashSummary(summary);

  const [existing] = await db
    .select()
    .from(insightsReports)
    .where(eq(insightsReports.yearMonth, ym))
    .limit(1);

  const stale = existing
    ? isStale(existing.generatedAt, existing.inputHash, currentHash)
    : true;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Insights</h1>
        <p className="text-body text-muted-foreground">
          Reporte mensual generado con Claude Sonnet. Se regenera si pasaron 24h
          o aparecieron nuevas transacciones en el mes.
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
