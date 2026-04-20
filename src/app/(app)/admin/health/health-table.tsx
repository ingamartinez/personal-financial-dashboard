"use client";

import { useTransition } from "react";
import { AlertTriangleIcon, RefreshCcwIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { runSnapshotNow } from "./actions";

type SnapshotSummary = {
  capturedAt: string;
  lastSmsReceivedAt: string | null;
  lastCaptureAt: string | null;
  captureSources30d: Record<string, number | undefined>;
  parserSuccessRate30d: number | null;
  unreconciledTxnCount: number;
  divergenceCents: string | null;
  statementDivergenceCents: string | null;
  churnSignalFlag: boolean;
};

type RecurringAdjustmentInsight = {
  kind: "recurring_same_direction_adjustments";
  direction: "in" | "out";
  count: number;
  totalCents: string;
  message: string;
  windowDays: number;
};

type UserHealthRow = {
  userId: number;
  email: string;
  name: string;
  pictureUrl: string | null;
  role: "admin" | "user";
  active: boolean;
  latest: SnapshotSummary | null;
  weekAgo: SnapshotSummary | null;
  insight?: RecurringAdjustmentInsight | null;
};

const PARSER_WARN_THRESHOLD = 0.9;
const UNRECONCILED_WARN = 20;
// 50k COP — large enough that a consistently-same-direction drift is worth
// investigating as a parser bug rather than dismissed as noise.
const DIVERGENCE_WARN_CENTS = BigInt(50_000_00);

export function HealthTable({ rows }: { rows: UserHealthRow[] }) {
  const [pending, startTransition] = useTransition();

  function trigger() {
    startTransition(async () => {
      const result = await runSnapshotNow();
      if (result.status === "error") {
        toast.error(`Snapshot falló: ${result.message}`);
      } else {
        toast.success(
          `Snapshots: ${result.users} usuarios, ${result.churnFlagged} con churn flag, ${result.failed} errores`,
        );
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-body text-muted-foreground">
          Snapshots diarios a las 03:00 COT. Usá <em>Correr ahora</em> para forzar una corrida
          manual.
        </p>
        <Button size="sm" variant="outline" disabled={pending} onClick={trigger}>
          <RefreshCcwIcon className="mr-1 size-4" /> Correr ahora
        </Button>
      </div>
      <div className="flex flex-col gap-3">
        {rows.map((row) => (
          <UserRowCard key={row.userId} row={row} />
        ))}
      </div>
    </div>
  );
}

function UserRowCard({ row }: { row: UserHealthRow }) {
  const { latest, weekAgo } = row;
  const churn = latest?.churnSignalFlag === true;
  const lowRate =
    latest?.parserSuccessRate30d !== null &&
    latest?.parserSuccessRate30d !== undefined &&
    latest.parserSuccessRate30d < PARSER_WARN_THRESHOLD;
  const highlight = churn || lowRate;

  return (
    <Card className={highlight ? "border-destructive/60" : undefined}>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {row.pictureUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={row.pictureUrl}
              alt=""
              className="size-10 rounded-full object-cover"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="bg-muted size-10 rounded-full" />
          )}
          <div className="flex flex-col">
            <CardTitle className="text-base">{row.name}</CardTitle>
            <span className="text-muted-foreground text-xs">{row.email}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!row.active && <Badge variant="destructive">inactivo</Badge>}
          {row.role === "admin" && <Badge variant="default">admin</Badge>}
          {churn && (
            <Badge variant="destructive" className="gap-1">
              <AlertTriangleIcon className="size-3" /> churn
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
          <Metric label="Último capture" value={formatRelative(latest?.lastCaptureAt)} />
          <Metric label="Último SMS" value={formatRelative(latest?.lastSmsReceivedAt)} />
          <Metric
            label="Parser success 30d"
            value={formatRate(latest?.parserSuccessRate30d)}
            diff={diffRate(latest?.parserSuccessRate30d, weekAgo?.parserSuccessRate30d)}
            warn={lowRate}
          />
          <Metric
            label="Unreconciled"
            value={formatCount(latest?.unreconciledTxnCount)}
            warn={(latest?.unreconciledTxnCount ?? 0) >= UNRECONCILED_WARN}
          />
          <Metric
            label="Divergence 30d"
            value={formatCents(latest?.divergenceCents)}
            warn={isDivergenceLarge(latest?.divergenceCents)}
          />
          <Metric
            label="Stmt divergence"
            value={formatCents(latest?.statementDivergenceCents)}
            warn={isDivergenceLarge(latest?.statementDivergenceCents)}
          />
          <Metric label="Sources 30d" value={formatSources(latest?.captureSources30d)} subtle />
        </div>
        {row.insight ? (
          <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50/60 p-3 text-sm text-amber-900">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            <div>
              <div className="font-medium">Parser bug suspected</div>
              <div className="text-xs">{row.insight.message}</div>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  diff,
  subtle,
  warn,
}: {
  label: string;
  value: string;
  diff?: string | null;
  subtle?: boolean;
  warn?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-foreground text-xs tracking-wide uppercase">{label}</span>
      <span
        className={`text-sm ${subtle ? "text-muted-foreground" : ""} ${warn ? "text-destructive font-medium" : ""}`}
      >
        {value}
      </span>
      {diff && <span className="text-muted-foreground text-xs">{diff}</span>}
    </div>
  );
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const days = Math.floor(diffMs / 86_400_000);
  if (days <= 0) return "hoy";
  if (days === 1) return "ayer";
  if (days < 30) return `hace ${days} días`;
  return date.toLocaleDateString("es-CO");
}

function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return "sin datos";
  return `${(rate * 100).toFixed(1)}%`;
}

function diffRate(now: number | null | undefined, prev: number | null | undefined): string | null {
  if (now === null || now === undefined || prev === null || prev === undefined) return null;
  const delta = now - prev;
  if (Math.abs(delta) < 0.001) return "estable vs semana anterior";
  const sign = delta > 0 ? "+" : "";
  return `${sign}${(delta * 100).toFixed(1)}pp vs semana anterior`;
}

function formatCount(n: number | undefined): string {
  if (n === undefined) return "—";
  return String(n);
}

function formatCents(cents: string | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  const n = BigInt(cents);
  const abs = n < BigInt(0) ? -n : n;
  const major = abs / BigInt(100);
  const sign = n < BigInt(0) ? "-" : "+";
  // Format with thousands separators in Spanish-style
  const grouped = major.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}$${grouped}`;
}

function isDivergenceLarge(cents: string | null | undefined): boolean {
  if (cents === null || cents === undefined) return false;
  const n = BigInt(cents);
  const abs = n < BigInt(0) ? -n : n;
  return abs >= DIVERGENCE_WARN_CENTS;
}

function formatSources(sources: Record<string, number | undefined> | undefined): string {
  if (!sources) return "—";
  const entries = Object.entries(sources).filter(([, v]) => typeof v === "number" && v > 0);
  if (entries.length === 0) return "sin capture";
  return entries
    .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
    .map(([k, v]) => `${k}:${v}`)
    .join(" · ");
}
