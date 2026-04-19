import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getSessionUser } from "@/lib/auth/session";
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
  searchParams: Promise<{ window?: string }>;
}) {
  const session = await getSessionUser();
  if (session.role !== "admin") notFound();

  const params = await searchParams;
  const windowDays = parseWindow(params.window);
  const slos = await computeAllSlos(windowDays);

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
          <SloCard key={slo.key} slo={slo} />
        ))}
      </div>
    </main>
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

function SloCard({ slo }: { slo: SloResult }) {
  const style = STATUS_STYLES[slo.status];
  return (
    <Card className={style.className}>
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
