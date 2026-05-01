import { and, eq, sql } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/lib/db";
import { insightsReports, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import { buildInsightsSummary, hashSummary, isStale } from "@/lib/ai/insights";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { getFinancialPeriod } from "@/lib/dashboard/period";
import { getUiPreferences } from "@/lib/preferences/repo";
import { formatMoney } from "@/lib/money";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { nowInBogota } from "@/lib/widgets/handlers/_shared";
import { fetchUserTcSnapshots } from "@/lib/queue/workers/tc-health-check";
import {
  computeTcAlerts,
  type TcCardSnapshot,
  type TcAlertTrigger,
} from "@/lib/insights/tc-health";
import { InsightsViewer } from "./insights-viewer";

export const dynamic = "force-dynamic";

function triggerLabel(trigger: TcAlertTrigger, snap: TcCardSnapshot): string {
  if (trigger === "statement") {
    const d = snap.daysToCutoff!;
    if (d === 0) return "corte hoy";
    if (d === 1) return "corte mañana";
    return `corte en ${d} días`;
  }
  const pct = snap.utilizationPct;
  return `cupo al ${pct}%`;
}

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
  const [currentPeriod, previousPeriod, prefs] = await Promise.all([
    getFinancialPeriod(session.id, new Date(Date.UTC(y, m - 1, 15))),
    getFinancialPeriod(session.id, new Date(Date.UTC(y, m - 2, 15))),
    getUiPreferences(session.id),
  ]);
  const summary = await buildInsightsSummary(
    session.id,
    ym,
    fx.rate,
    undefined,
    {
      currentRange: { start: currentPeriod.start, end: currentPeriod.end },
      previousRange: { start: previousPeriod.start, end: previousPeriod.end },
    },
    { displayCurrencyMode: prefs.displayCurrencyMode },
  );
  const currentHash = hashSummary(summary);

  const [existing] = await db
    .select()
    .from(insightsReports)
    .where(and(eq(insightsReports.userId, session.id), eq(insightsReports.yearMonth, ym)))
    .limit(1);

  const stale = existing ? isStale(existing.generatedAt, existing.inputHash, currentHash) : true;

  // Uncategorized counter — all-time, tenant-scoped (#628)
  const [uncategorized] = await db
    .select({
      count: sql<number>`COUNT(*)::int`,
      totalCents: sql<string>`COALESCE(SUM(ABS(amount_cents)), 0)::text`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, session.id),
        eq(transactions.classificationMethod, "user_uncategorized"),
        notDeleted(transactions.deletedAt),
      ),
    );

  const uncategorizedCount = uncategorized?.count ?? 0;
  const uncategorizedCents = BigInt(uncategorized?.totalCents ?? "0");

  // TC Health card — real-time snapshot of all the user's TCs (#705)
  const today = nowInBogota(new Date());
  const tcSnapshots = await fetchUserTcSnapshots(session.id, fx.rate, today);
  const tcAlerts: Array<{ snap: TcCardSnapshot; triggers: TcAlertTrigger[] }> = tcSnapshots
    .map((snap) => ({ snap, triggers: computeTcAlerts(snap) }))
    .filter((a) => a.triggers.length > 0);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Insights</h1>
        <p className="text-body text-muted-foreground">
          Reporte mensual generado con Claude Sonnet. Se regenera si pasaron 24h o aparecieron
          nuevas transacciones en el mes.
        </p>
      </header>

      {/* Sin categorizar widget (#628) */}
      <Card className="border-amber-200 bg-amber-50/40 dark:border-amber-900 dark:bg-amber-950/15">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-amber-900 dark:text-amber-200">
            Sin categorizar
          </CardTitle>
        </CardHeader>
        <CardContent>
          {uncategorizedCount === 0 ? (
            <p className="text-muted-foreground text-sm">Todo está categorizado, fantástico.</p>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm">
                {uncategorizedCount} transacci{uncategorizedCount === 1 ? "ón" : "ones"}
                {" · "}
                {formatMoney(uncategorizedCents, "COP")}
              </p>
              <Link
                href="/settings/inbox"
                className="text-xs text-amber-700 underline underline-offset-4 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
              >
                Revisar →
              </Link>
            </div>
          )}
        </CardContent>
      </Card>

      {/* TC Health card (#705) */}
      <Card className="border-rose-200 bg-rose-50/40 dark:border-rose-900 dark:bg-rose-950/15">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-rose-900 dark:text-rose-200">
            Salud de tarjetas
          </CardTitle>
        </CardHeader>
        <CardContent>
          {tcAlerts.length === 0 ? (
            <p className="text-muted-foreground text-sm">Todas las tarjetas están en orden.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {tcAlerts.map(({ snap, triggers }) => (
                <li key={snap.cardId} className="flex items-start justify-between gap-2 text-sm">
                  <span>
                    <span className="font-medium">{snap.label}</span>
                    {" · "}
                    {triggers.map((t) => triggerLabel(t, snap)).join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

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
