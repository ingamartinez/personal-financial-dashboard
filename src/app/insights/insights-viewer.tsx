"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { ChevronLeftIcon, ChevronRightIcon, RefreshCwIcon, SparklesIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatCop } from "@/lib/money";
import { cn } from "@/lib/utils";
import { generateInsight } from "./actions";

type SummaryPreview = {
  incomeCop: number;
  expenseCop: number;
  netCop: number;
  previousNetCop: number;
  txCount: number;
  categoryCount: number;
};

type ReportState = {
  markdown: string;
  generatedAt: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  stale: boolean;
} | null;

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("es-CO", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours < 1) return "hace menos de 1 hora";
  if (hours < 24) return `hace ${hours} hora${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `hace ${days} día${days === 1 ? "" : "s"}`;
}

export function InsightsViewer({
  ym,
  summary,
  report,
}: {
  ym: string;
  summary: SummaryPreview;
  report: ReportState;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function goMonth(delta: number) {
    router.push(`/insights?ym=${shiftMonth(ym, delta)}`);
  }

  function onGenerate() {
    startTransition(async () => {
      try {
        await generateInsight(ym);
        toast.success("Reporte generado");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Fallo al generar");
      }
    });
  }

  const netDelta = summary.netCop - summary.previousNetCop;
  const effectiveReport = report;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => goMonth(-1)} aria-label="Previous">
            <ChevronLeftIcon className="size-4" />
          </Button>
          <div className="px-2 text-sm font-medium capitalize">{formatMonth(ym)}</div>
          <Button variant="outline" size="sm" onClick={() => goMonth(1)} aria-label="Next">
            <ChevronRightIcon className="size-4" />
          </Button>
        </div>
        <Button onClick={onGenerate} disabled={pending}>
          {effectiveReport ? (
            <RefreshCwIcon className={cn("size-4", pending && "animate-spin")} />
          ) : (
            <SparklesIcon className="size-4" />
          )}
          {pending ? "Generando…" : effectiveReport ? "Regenerar" : "Generar reporte"}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatCard label="Ingresos" value={formatCop(BigInt(summary.incomeCop * 100))} />
        <StatCard label="Gastos" value={formatCop(BigInt(summary.expenseCop * 100))} />
        <StatCard
          label="Neto"
          value={formatCop(BigInt(summary.netCop * 100))}
          valueClass={summary.netCop >= 0 ? "text-emerald-600" : "text-rose-600"}
          sub={
            netDelta === 0
              ? undefined
              : `${netDelta > 0 ? "+" : ""}${formatCop(BigInt(netDelta * 100))} vs mes anterior`
          }
        />
        <StatCard
          label="Transacciones"
          value={summary.txCount.toString()}
          sub={`${summary.categoryCount} categorías`}
        />
      </div>

      {effectiveReport ? (
        <Card>
          <CardContent className="flex flex-col gap-3 py-4">
            <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 border-b pb-2 text-xs">
              <div>
                Generado {formatRelative(effectiveReport.generatedAt)} · {effectiveReport.model} ·{" "}
                {effectiveReport.inputTokens + effectiveReport.outputTokens} tokens
              </div>
              {effectiveReport.stale && (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">
                  stale — regenerá para actualizar
                </span>
              )}
            </div>
            <article className="prose prose-sm dark:prose-invert prose-headings:font-semibold prose-h2:text-lg prose-h2:mt-4 prose-h2:mb-2 prose-p:leading-relaxed prose-ul:my-2 prose-li:my-0.5 max-w-none">
              <ReactMarkdown>{effectiveReport.markdown}</ReactMarkdown>
            </article>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <EmptyState
            icon={<SparklesIcon />}
            title={`No hay reporte para ${formatMonth(ym)}`}
            description="Generar un reporte llama a Claude Sonnet con el resumen del mes. Se cachea por 24h."
            action={
              <Button onClick={onGenerate} disabled={pending}>
                <SparklesIcon className="size-4" />
                {pending ? "Generando…" : "Generar reporte"}
              </Button>
            }
          />
        </Card>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  valueClass,
}: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-0.5 py-3">
        <div className="text-muted-foreground text-xs">{label}</div>
        <div className={cn("text-lg font-semibold tabular-nums", valueClass)}>{value}</div>
        {sub && <div className="text-muted-foreground text-[10px]">{sub}</div>}
      </CardContent>
    </Card>
  );
}
