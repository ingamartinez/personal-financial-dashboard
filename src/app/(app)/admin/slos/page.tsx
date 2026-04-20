import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getSessionUser } from "@/lib/auth/session";
import {
  CANARY_AGREEMENT_THRESHOLD,
  CANARY_MIN_SAMPLES,
  computeAgreementRate24h,
  computeAgreementTrend30d,
} from "@/lib/observability/canary-alerts";
import {
  computeAllSlos,
  type SloResult,
  type SloStatus,
  type SloWindow,
} from "@/lib/telemetry/slos";
import { Sparkline } from "./sparkline";

export const dynamic = "force-dynamic";

const ALLOWED_WINDOWS: SloWindow[] = [7, 30, 90];

function parseWindow(value: string | undefined): SloWindow {
  const n = Number(value);
  if (ALLOWED_WINDOWS.includes(n as SloWindow)) return n as SloWindow;
  return 30;
}

export default async function AdminSlosPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string; focus?: string }>;
}) {
  const session = await getSessionUser();
  if (session.role !== "admin") notFound();

  const params = await searchParams;
  const windowDays = parseWindow(params.window);
  const focus = params.focus;
  const [slos, canaryStats, canaryTrend] = await Promise.all([
    computeAllSlos(windowDays),
    computeAgreementRate24h(),
    computeAgreementTrend30d(),
  ]);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-h1">SLOs del parser</h1>
          <p className="text-body text-muted-foreground">
            6 métricas agregadas cross-user. Gatean Phase 8 (segundo banco) — sin verde sostenido,
            no agregamos más complejidad.
          </p>
        </div>
        <WindowPicker current={windowDays} />
      </header>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {slos.map((slo) => (
          <SloCard key={slo.key} slo={slo} focused={focus === slo.key} />
        ))}
      </div>
      <section className="flex flex-col gap-2">
        <h2 className="text-h2">AI Canary</h2>
        <p className="text-body text-muted-foreground">
          Shadow-parse por Haiku del 1% del tráfico — detecta drift de formato antes que el usuario.
          Alerta cuando agreement &lt; {(CANARY_AGREEMENT_THRESHOLD * 100).toFixed(0)}% sostenido
          24h (mínimo {CANARY_MIN_SAMPLES} muestras).
        </p>
        <div className="grid grid-cols-1 gap-4">
          <CanaryCard stats={canaryStats} trend={canaryTrend} />
        </div>
      </section>
    </main>
  );
}

function CanaryCard({
  stats,
  trend,
}: {
  stats: { rate: number | null; total: number; disagrees: number };
  trend: { date: string; value: number | null }[];
}) {
  const status: SloStatus =
    stats.rate === null || stats.total < CANARY_MIN_SAMPLES
      ? "no-signal"
      : stats.rate >= CANARY_AGREEMENT_THRESHOLD
        ? "green"
        : stats.rate >= CANARY_AGREEMENT_THRESHOLD - 0.05
          ? "yellow"
          : "red";
  const style = STATUS_STYLES[status];
  const display = stats.rate === null ? "—" : `${(stats.rate * 100).toFixed(1)}%`;
  return (
    <Card className={style.className}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <CardTitle className="text-base">Agreement rate (24h)</CardTitle>
            <CardDescription className="text-xs">
              {stats.total} muestra{stats.total === 1 ? "" : "s"} · {stats.disagrees} disagree
              {stats.disagrees === 1 ? "" : "s"}
            </CardDescription>
          </div>
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-white/60 px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase dark:bg-black/20"
            title={style.label}
          >
            <span className={`size-2 rounded-full ${style.dot}`} />
            {style.label}
          </span>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-baseline gap-3">
          <span className="font-heading text-3xl font-semibold tabular-nums">{display}</span>
          <span className="text-muted-foreground text-xs">
            Target ≥ {(CANARY_AGREEMENT_THRESHOLD * 100).toFixed(0)}%
          </span>
        </div>
        {trend.length > 0 ? (
          <Sparkline points={trend} />
        ) : (
          <p className="text-muted-foreground text-[11px] italic">Trend no disponible todavía.</p>
        )}
        <Link
          href="/admin/slos/canary"
          className="text-xs font-medium underline-offset-4 hover:underline"
        >
          Ver eventos de disagree →
        </Link>
      </CardContent>
    </Card>
  );
}

function WindowPicker({ current }: { current: SloWindow }) {
  return (
    <nav className="flex items-center gap-1 text-xs">
      <span className="text-muted-foreground mr-1">Ventana:</span>
      {ALLOWED_WINDOWS.map((w) => {
        const active = w === current;
        return (
          <Link
            key={w}
            href={`?window=${w}`}
            className={
              active
                ? "bg-foreground text-background rounded px-2 py-1 font-medium"
                : "text-muted-foreground hover:text-foreground rounded px-2 py-1"
            }
          >
            {w}d
          </Link>
        );
      })}
    </nav>
  );
}

const STATUS_STYLES: Record<SloStatus, { label: string; className: string; dot: string }> = {
  green: {
    label: "OK",
    className:
      "border-emerald-300 bg-emerald-50/60 dark:border-emerald-900/40 dark:bg-emerald-950/20",
    dot: "bg-emerald-500",
  },
  yellow: {
    label: "Atención",
    className: "border-amber-300 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/20",
    dot: "bg-amber-500",
  },
  red: {
    label: "Crítico",
    className: "border-red-300 bg-red-50/60 dark:border-red-900/40 dark:bg-red-950/20",
    dot: "bg-red-500",
  },
  "no-signal": {
    label: "Sin señal",
    className: "border-border bg-muted/30",
    dot: "bg-muted-foreground",
  },
};

function SloCard({ slo, focused }: { slo: SloResult; focused: boolean }) {
  const style = STATUS_STYLES[slo.status];
  // Focused cards get a subtle ring so operators landing from a Telegram alert
  // deep link (/admin/slos?focus=parse_success) can spot the flagged SLO.
  const focusClass = focused ? "ring-2 ring-offset-2 ring-amber-500" : "";
  return (
    <Card className={`${style.className} ${focusClass}`}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <CardTitle className="text-base">{slo.label}</CardTitle>
            <CardDescription className="text-xs">{slo.description}</CardDescription>
          </div>
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-white/60 px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase dark:bg-black/20"
            title={style.label}
          >
            <span className={`size-2 rounded-full ${style.dot}`} />
            {style.label}
          </span>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-baseline gap-3">
          <span className="font-heading text-3xl font-semibold tabular-nums">{slo.display}</span>
          <span className="text-muted-foreground text-xs">Target {slo.target}</span>
        </div>
        {slo.trend.length > 0 ? (
          <Sparkline points={slo.trend} />
        ) : (
          <p className="text-muted-foreground text-[11px] italic">
            Trend no disponible para esta métrica todavía.
          </p>
        )}
        {slo.drilldown ? (
          <Link
            href={slo.drilldown}
            className="text-xs font-medium underline-offset-4 hover:underline"
          >
            Ver detalle →
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}
