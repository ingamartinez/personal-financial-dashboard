import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
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
import { fetchUserTcSnapshots, nowInBogota } from "@/lib/insights/tc-health-queries";
import {
  computeTcAlerts,
  type TcCardSnapshot,
  type TcAlertTrigger,
} from "@/lib/insights/tc-health";
import { fetchRecentAnomalies } from "@/lib/insights/merchant-anomaly-queries";
import { fetchCashFlowSummary } from "@/lib/insights/cash-flow-queries";
import { fetchTemporalSummary } from "@/lib/insights/temporal-queries";
import { fetchRecentDuplicatePayments } from "@/lib/insights/duplicate-payment-queries";
import { fetchSavingsSuggestion } from "@/lib/insights/savings-suggestions-queries";
import { dowNameEs, monthNameEs } from "@/lib/insights/temporal";
import { SpendingHeatmap } from "@/components/insights/spending-heatmap";
import { SavingsSuggestionsCard } from "@/components/insights/savings-suggestions-card";
import { canAccessFeature } from "@/lib/auth/can-access-feature";
import { CONFIDENCE_LOW_THRESHOLD } from "@/components/transactions/confidence-badge";
import { CategorizationCardBody } from "@/components/insights/categorization-card";
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

// ---------------------------------------------------------------------------
// Cash flow forecast card — D.4 (#715)
// ---------------------------------------------------------------------------

type CashFlowCardProps = {
  summary: Awaited<ReturnType<typeof fetchCashFlowSummary>>;
};

function CashFlowCard({ summary }: CashFlowCardProps) {
  const { colorBand, shortfallDate, daysUntilShortfall, forecast } = summary;

  const borderClass =
    colorBand === "rose"
      ? "border-rose-200 bg-rose-50/40 dark:border-rose-900 dark:bg-rose-950/15"
      : colorBand === "amber"
        ? "border-amber-200 bg-amber-50/40 dark:border-amber-900 dark:bg-amber-950/15"
        : "border-emerald-200 bg-emerald-50/40 dark:border-emerald-900 dark:bg-emerald-950/15";

  const titleClass =
    colorBand === "rose"
      ? "text-rose-900 dark:text-rose-200"
      : colorBand === "amber"
        ? "text-amber-900 dark:text-amber-200"
        : "text-emerald-900 dark:text-emerald-200";

  return (
    <Card className={borderClass}>
      <CardHeader className="pb-2">
        <CardTitle className={`text-sm font-medium ${titleClass}`}>Próximos 30 días</CardTitle>
      </CardHeader>
      <CardContent>
        {colorBand === "emerald" ? (
          <p className="text-muted-foreground text-sm">
            Saldo proyectado positivo durante los próximos 30 días.{" "}
            <span className="font-medium">Mínimo: {formatMoney(forecast.minBalance, "COP")}</span> (
            {forecast.minBalanceDate}).
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="text-sm">
              <span className="font-medium">Saldo mínimo proyectado:</span>{" "}
              {formatMoney(forecast.minBalance, "COP")} el {forecast.minBalanceDate}.
            </p>
            {shortfallDate !== undefined && daysUntilShortfall !== undefined && (
              <p className="text-sm">
                <span className="font-medium">Saldo negativo</span> proyectado el{" "}
                <span className="font-medium">{shortfallDate}</span>
                {daysUntilShortfall <= 7 ? (
                  <span className="ml-1 font-semibold text-rose-700 dark:text-rose-300">
                    (en {daysUntilShortfall} día{daysUntilShortfall === 1 ? "" : "s"})
                  </span>
                ) : (
                  <span className="ml-1 text-amber-700 dark:text-amber-300">
                    (en {daysUntilShortfall} días)
                  </span>
                )}
                . Revisá tus próximos gastos e ingresos.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
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

  // Categorización card — two separate queries, tenant-scoped, all-time (#723)
  //
  // Row 1 "Pendientes de revisar": low-confidence rule/ai + fully unclassified
  // Row 2 "Marcadas como otros": explicitly marked user_uncategorized (resolved, not action-required)
  const pendingWhere = and(
    eq(transactions.userId, session.id),
    or(
      and(
        inArray(transactions.classificationMethod, ["rule", "ai"]),
        lt(transactions.classificationConfidence, CONFIDENCE_LOW_THRESHOLD),
      ),
      eq(transactions.classificationMethod, "unclassified"),
    ),
    notDeleted(transactions.deletedAt),
  );
  const otrosWhere = and(
    eq(transactions.userId, session.id),
    eq(transactions.classificationMethod, "user_uncategorized"),
    notDeleted(transactions.deletedAt),
  );

  const [[pendingRow], [otrosRow]] = await Promise.all([
    db
      .select({
        count: sql<number>`COUNT(*)::int`,
        totalCents: sql<string>`COALESCE(SUM(ABS(amount_cents)), 0)::text`,
      })
      .from(transactions)
      .where(pendingWhere),
    db
      .select({
        count: sql<number>`COUNT(*)::int`,
        totalCents: sql<string>`COALESCE(SUM(ABS(amount_cents)), 0)::text`,
      })
      .from(transactions)
      .where(otrosWhere),
  ]);

  const pendingCount = pendingRow?.count ?? 0;
  const pendingCents = BigInt(pendingRow?.totalCents ?? "0");
  const otrosCount = otrosRow?.count ?? 0;
  const otrosCents = BigInt(otrosRow?.totalCents ?? "0");

  // TC Health card — real-time snapshot of all the user's TCs (#705)
  const nowDate = new Date();
  const today = nowInBogota(nowDate);
  const [
    tcSnapshots,
    recentAnomalies,
    cashFlowSummary,
    temporalSummary,
    recentDuplicatePayments,
    savingsSuggestions,
    canSeeSavings,
  ] = await Promise.all([
    fetchUserTcSnapshots(session.id, fx.rate, today),
    fetchRecentAnomalies(session.id),
    fetchCashFlowSummary(session.id, nowDate),
    fetchTemporalSummary(session.id, nowDate),
    fetchRecentDuplicatePayments(session.id),
    fetchSavingsSuggestion(session.id),
    canAccessFeature(session.id, "cdt-suggestion"),
  ]);
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

      {/* Categorización card — two rows: pending review + marcadas como otros (#723) */}
      <Card className="border-amber-200 bg-amber-50/40 dark:border-amber-900 dark:bg-amber-950/15">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-amber-900 dark:text-amber-200">
            Categorización
          </CardTitle>
        </CardHeader>
        <CardContent>
          <CategorizationCardBody
            pendingCount={pendingCount}
            pendingCents={pendingCents}
            otrosCount={otrosCount}
            otrosCents={otrosCents}
          />
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

      {/* Anomalías recientes card (#713 B.1+B.2) */}
      <Card className="border-orange-200 bg-orange-50/40 dark:border-orange-900 dark:bg-orange-950/15">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-orange-900 dark:text-orange-200">
            Anomalías recientes
          </CardTitle>
        </CardHeader>
        <CardContent>
          {recentAnomalies.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Sin anomalías ni comercios nuevos en los últimos 7 días.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {recentAnomalies.map((row) => (
                <li key={`${row.txId}`} className="flex items-start justify-between gap-2 text-sm">
                  <span>
                    <span className="font-medium">{row.canonicalMerchant}</span>
                    {" · "}
                    {row.kind === "anomaly" && row.factor !== null ? (
                      <span>
                        {row.factor.toFixed(1)}× promedio habitual ·{" "}
                        {formatMoney(BigInt(row.deltaCents ?? "0"), row.currency as "COP" | "USD")}{" "}
                        más de lo usual
                      </span>
                    ) : (
                      <span className="text-orange-700 dark:text-orange-300">nuevo comercio</span>
                    )}
                  </span>
                  <Link
                    href={`/transactions?highlight=${row.txId}`}
                    className="shrink-0 text-xs text-orange-700 underline underline-offset-4 hover:text-orange-900 dark:text-orange-300 dark:hover:text-orange-100"
                  >
                    Ver →
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Próximos 30 días — D.4 cash flow forecast card (#715) */}
      <CashFlowCard summary={cashFlowSummary} />

      {/* Patrones de gasto — E.1+E.2+E.3 temporal patterns card (#717) */}
      <Card className="border-slate-200 bg-slate-50/40 dark:border-slate-800 dark:bg-slate-950/15">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-slate-900 dark:text-slate-200">
            Patrones de gasto
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* E.1 — Daily heatmap */}
          {temporalSummary.hasNoData ? (
            <p className="text-muted-foreground text-sm">
              Sin datos suficientes para mostrar el patrón.
            </p>
          ) : (
            <SpendingHeatmap dayBuckets={temporalSummary.dayBuckets} />
          )}

          {/* E.2 — Expensive days */}
          {temporalSummary.expensiveDays.length > 0 && (
            <ul className="flex flex-col gap-1">
              {temporalSummary.expensiveDays.map((row) => (
                <li key={row.dow} className="text-sm text-slate-800 dark:text-slate-300">
                  <span className="font-medium capitalize">{dowNameEs(row.dow)}</span>
                  {": en promedio gastás "}
                  <span className="font-medium">{row.deltaPct}%</span>
                  {" más que otros días"}
                </li>
              ))}
            </ul>
          )}

          {/* E.3 — Seasonality */}
          {temporalSummary.seasonality.length > 0 && (
            <ul className="flex flex-col gap-1">
              {temporalSummary.seasonality.map((row) => (
                <li key={row.monthIndex} className="text-sm text-slate-800 dark:text-slate-300">
                  <span className="font-medium capitalize">{monthNameEs(row.monthIndex)}</span>
                  {": gasto histórico "}
                  <span className="font-medium">{row.deltaPct}%</span>
                  {" más alto que el promedio anual"}
                </li>
              ))}
            </ul>
          )}

          {/* Fallback when all three subsections are empty but there IS data */}
          {!temporalSummary.hasNoData &&
            temporalSummary.expensiveDays.length === 0 &&
            temporalSummary.seasonality.length === 0 && (
              <p className="text-muted-foreground text-sm">
                Sin patrones destacados por el momento.
              </p>
            )}
        </CardContent>
      </Card>

      {/* Pagos duplicados detectados card — C.4 (#719) */}
      <Card className="border-violet-200 bg-violet-50/40 dark:border-violet-900 dark:bg-violet-950/15">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-violet-900 dark:text-violet-200">
            Pagos duplicados detectados
          </CardTitle>
        </CardHeader>
        <CardContent>
          {recentDuplicatePayments.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No hemos detectado pagos duplicados en los últimos 30 días.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {recentDuplicatePayments.map((row) => (
                <li
                  key={`${row.newTxId}`}
                  className="flex items-start justify-between gap-2 text-sm"
                >
                  <span>
                    <span className="font-medium">{row.canonicalMerchant}</span>
                    {" · "}
                    <span className="text-violet-800 dark:text-violet-300">
                      {row.newAccountLabel}
                    </span>
                    {" y "}
                    <span className="text-violet-800 dark:text-violet-300">
                      {row.otherAccountLabel}
                    </span>
                  </span>
                  <Link
                    href={`/transactions?highlight=${row.newTxId}`}
                    className="shrink-0 text-xs text-violet-700 underline underline-offset-4 hover:text-violet-900 dark:text-violet-300 dark:hover:text-violet-100"
                  >
                    Ver →
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Optimizá tus ahorros — C.1 CDT + C.2 FIC savings suggestions (#721) */}
      {canSeeSavings && savingsSuggestions.length > 0 && (
        <SavingsSuggestionsCard rows={savingsSuggestions} />
      )}

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
