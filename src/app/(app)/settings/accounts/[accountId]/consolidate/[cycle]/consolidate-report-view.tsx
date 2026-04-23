"use client";

import { AlertTriangleIcon, CheckCircleIcon, PlusCircleIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type {
  BalanceProjection,
  ConsolidationReport,
} from "@/lib/ingestion/bancolombia-statement/consolidate";

export function formatCents(str: string): string {
  if (!str) return "—";
  const big = BigInt(str);
  const negative = big < BigInt(0);
  const abs = negative ? -big : big;
  const units = abs / BigInt(100);
  const fractional = (abs % BigInt(100)).toString().padStart(2, "0");
  const unitsStr = units.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}$${unitsStr},${fractional}`;
}

export function formatRate(x10k: number | null): string {
  if (x10k == null) return "—";
  const whole = Math.floor(x10k / 10_000);
  const frac = (x10k % 10_000).toString().padStart(4, "0");
  return `${whole},${frac}%`;
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "short",
    timeZone: "America/Bogota",
  }).format(new Date(iso));
}

export function sectionLabel(report: ConsolidationReport): string {
  return `${report.currency} · cuenta #${report.accountId}`;
}

export function ReportSection({
  report,
  showHeading,
}: {
  report: ConsolidationReport;
  showHeading: boolean;
}) {
  const willChangeRows = report.matchedDiffs.filter((d) => d.willChange);
  const noChangeMatches = report.matchedDiffs.length - willChangeRows.length;
  const interesesLine =
    report.intereses.status === "inserted"
      ? `se insertó 1 tx sintética intereses-tc por ${formatCents(report.intereses.totalInterestCentsStr)}`
      : report.intereses.status === "skipped"
        ? `no se insertó tx sintética (${report.intereses.reason})`
        : report.dryRun
          ? `intereses se corren al confirmar (dry-run lo omite)`
          : `intereses: ${report.intereses.reason}`;
  return (
    <section
      data-testid="consolidate-report-section"
      className={cn("flex flex-col gap-4", showHeading && "rounded-md border border-dashed p-4")}
    >
      {showHeading ? (
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="text-sm font-semibold">{sectionLabel(report)}</h3>
          <Badge variant="outline">{report.status}</Badge>
        </div>
      ) : null}
      {report.projection ? (
        <BalanceProjectionSection projection={report.projection} dryRun={report.dryRun} />
      ) : null}
      <SummaryGrid report={report} />
      <Alert>
        <AlertTitle>Intereses-causados</AlertTitle>
        <AlertDescription>
          {interesesLine}.{" "}
          {report.intereses.status === "inserted"
            ? `Compras multi-cuota sin tasa: ${report.intereses.purchasesNeedingRate}.`
            : null}
        </AlertDescription>
      </Alert>

      <MatchesSection rows={willChangeRows} noChangeCount={noChangeMatches} />
      <MissingSection missing={report.missingInLedger} />
      <UnmatchedSection ids={report.unmatchedInLedgerIds} />
    </section>
  );
}

function SummaryGrid({ report }: { report: ConsolidationReport }) {
  return (
    <dl className="grid grid-cols-2 gap-2 rounded-md border p-3 text-sm sm:grid-cols-5">
      <Stat label="Matched" value={report.matchStats.matched} />
      <Stat label="Updates" value={report.matchStats.matchedWillChange} />
      <Stat label="Nuevas" value={report.matchStats.insertedMissing} />
      <Stat label="Antes (skip)" value={report.matchStats.skippedMissingBefore} />
      <Stat label="Sin match" value={report.matchStats.unmatchedInLedger} muted />
    </dl>
  );
}

function Stat({ label, value, muted = false }: { label: string; value: number; muted?: boolean }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={cn("font-medium", muted && "text-muted-foreground")}>{value}</dd>
    </div>
  );
}

function MatchesSection({
  rows,
  noChangeCount,
}: {
  rows: ConsolidationReport["matchedDiffs"];
  noChangeCount: number;
}) {
  return (
    <Collapsible defaultOpen={rows.length > 0}>
      <CollapsibleTrigger
        data-testid="consolidate-matches-trigger"
        className="hover:bg-muted flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm"
      >
        <span className="flex items-center gap-2 font-medium">
          <CheckCircleIcon className="size-4 text-emerald-600 dark:text-emerald-400" />
          Con updates ({rows.length})
          {noChangeCount > 0 ? (
            <span className="text-muted-foreground text-xs">+{noChangeCount} ya alineadas</span>
          ) : null}
        </span>
        <Badge variant="secondary">{rows.length}</Badge>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        {rows.length === 0 ? (
          <p className="text-muted-foreground px-3 py-2 text-xs">
            Ninguna fila matched requiere update — todas ya estaban alineadas con el extracto.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground text-xs">
                <tr>
                  <th className="py-1 pr-3">Fecha</th>
                  <th className="py-1 pr-3">Merchant</th>
                  <th className="py-1 pr-3 text-right">Monto</th>
                  <th className="py-1 pr-3">Cuotas</th>
                  <th className="py-1 pr-3">Tasa EM</th>
                  <th className="py-1 pr-3 text-right">Tx</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.txId} className="border-t">
                    <td className="py-1 pr-3">{formatDate(row.occurredAt)}</td>
                    <td className="truncate py-1 pr-3">{row.merchant}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">
                      {formatCents(row.amountCentsStr)}
                    </td>
                    <td className="py-1 pr-3 tabular-nums">
                      {row.installmentsTotalBefore} → {row.installmentsTotalAfter}
                    </td>
                    <td className="py-1 pr-3 tabular-nums">
                      {formatRate(row.rateEmX10kBefore)} → {formatRate(row.rateEmX10kAfter)}
                    </td>
                    <td className="text-muted-foreground py-1 pr-3 text-right text-xs">
                      #{row.txId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function MissingSection({ missing }: { missing: ConsolidationReport["missingInLedger"] }) {
  const during = missing.filter((r) => r.kind === "during-period");
  const before = missing.filter((r) => r.kind === "before-period");

  return (
    <Collapsible defaultOpen={during.length > 0}>
      <CollapsibleTrigger
        data-testid="consolidate-missing-trigger"
        className="hover:bg-muted flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm"
      >
        <span className="flex items-center gap-2 font-medium">
          <PlusCircleIcon className="size-4 text-sky-600 dark:text-sky-400" />
          Nuevas ({during.length})
          {before.length > 0 ? (
            <span className="text-muted-foreground text-xs">+{before.length} antes del ciclo</span>
          ) : null}
        </span>
        <Badge variant="secondary">{during.length}</Badge>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        {missing.length === 0 ? (
          <p className="text-muted-foreground px-3 py-2 text-xs">
            No hay compras en el extracto que falten en Findash.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground text-xs">
                <tr>
                  <th className="py-1 pr-3">Fecha</th>
                  <th className="py-1 pr-3">Merchant</th>
                  <th className="py-1 pr-3 text-right">Monto</th>
                  <th className="py-1 pr-3">Auth</th>
                  <th className="py-1 pr-3">Acción</th>
                </tr>
              </thead>
              <tbody>
                {missing.map((row) => (
                  <tr key={`${row.authorizationNumber}-${row.occurredAt}`} className="border-t">
                    <td className="py-1 pr-3">{formatDate(row.occurredAt)}</td>
                    <td className="truncate py-1 pr-3">{row.merchant}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">
                      {formatCents(row.amountCentsStr)}
                    </td>
                    <td className="py-1 pr-3 font-mono text-xs">
                      {row.authorizationNumber ?? "—"}
                    </td>
                    <td className="py-1 pr-3">
                      {row.kind === "during-period" ? (
                        <Badge variant="secondary">insert</Badge>
                      ) : (
                        <Badge variant="outline">before — skip</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function formatSignedCents(str: string): string {
  if (!str) return "—";
  const big = BigInt(str);
  const formatted = formatCents(str);
  if (big > BigInt(0) && !formatted.startsWith("+")) return `+${formatted}`;
  return formatted;
}

function BalanceProjectionSection({
  projection,
  dryRun,
}: {
  projection: BalanceProjection;
  dryRun: boolean;
}) {
  const deltaCents = BigInt(projection.deltaCentsStr);
  const isZeroDelta = deltaCents === BigInt(0);
  const plugsCents = BigInt(projection.breakdown.plugsObsoletosCentsStr);

  return (
    <section
      data-testid="consolidate-projection"
      className="flex flex-col gap-3 rounded-md border p-3 text-sm"
    >
      <div className="flex items-baseline gap-2">
        <h4 className="font-semibold">Proyección de saldo</h4>
        {dryRun ? (
          <span className="text-muted-foreground text-xs">(preview)</span>
        ) : (
          <span className="text-muted-foreground text-xs">(aplicado)</span>
        )}
      </div>

      {isZeroDelta ? (
        <p className="text-muted-foreground text-xs" data-testid="consolidate-projection-zero">
          Sin cambios en saldo — este ciclo no aporta compras nuevas ni intereses.
        </p>
      ) : (
        <>
          <p className="text-sm">
            Saldo disponible cambiará de{" "}
            <span className="font-medium tabular-nums">
              {formatCents(projection.saldoActualCentsStr)}
            </span>{" "}
            →{" "}
            <span className="font-medium tabular-nums">
              {formatCents(projection.saldoProyectadoCentsStr)}
            </span>{" "}
            (delta:{" "}
            <span
              data-testid="consolidate-projection-delta"
              className={cn(
                "font-semibold tabular-nums",
                deltaCents < BigInt(0)
                  ? "text-rose-700 dark:text-rose-400"
                  : "text-emerald-700 dark:text-emerald-400",
              )}
            >
              {formatSignedCents(projection.deltaCentsStr)}
            </span>
            )
          </p>
          <ul className="text-muted-foreground ml-4 list-disc space-y-0.5 text-xs">
            <li>
              Compras nuevas:{" "}
              <span className="tabular-nums">
                {formatSignedCents(projection.breakdown.comprasNuevasCentsStr)}
              </span>
            </li>
            <li>
              Intereses causados:{" "}
              {projection.breakdown.interesesCentsStr === null ? (
                <span className="italic">se calculan al confirmar (no incluidos en el delta)</span>
              ) : (
                <span className="tabular-nums">
                  {formatSignedCents(projection.breakdown.interesesCentsStr)}
                </span>
              )}
            </li>
            {plugsCents !== BigInt(0) ? (
              <li>
                Balance adjustments previos (≤ fin del ciclo):{" "}
                <span className="tabular-nums">
                  {formatSignedCents(projection.breakdown.plugsObsoletosCentsStr)}
                </span>{" "}
                <span className="italic">— podrían estar obsoletos</span>
              </li>
            ) : null}
            {projection.breakdown.balanceAdjustmentPlugCentsStr !== null &&
            BigInt(projection.breakdown.balanceAdjustmentPlugCentsStr) !== BigInt(0) ? (
              <li data-testid="consolidate-projection-adjustment-plug">
                Ajuste de saldo (saldo real ingresado):{" "}
                <span className="tabular-nums">
                  {formatSignedCents(projection.breakdown.balanceAdjustmentPlugCentsStr)}
                </span>
              </li>
            ) : null}
          </ul>
        </>
      )}

      {projection.warn.exceeded ? (
        <Alert
          variant="default"
          data-testid="consolidate-projection-warn"
          className="border-amber-500/50 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <AlertTriangleIcon className="size-4" />
          <AlertTitle>Delta grande</AlertTitle>
          <AlertDescription>
            Revisá la sección &quot;Nuevas&quot; antes de confirmar — ¿esperabas este cambio?
          </AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}

function UnmatchedSection({ ids }: { ids: number[] }) {
  return (
    <Collapsible>
      <CollapsibleTrigger
        data-testid="consolidate-unmatched-trigger"
        className="hover:bg-muted flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm"
      >
        <span className="flex items-center gap-2 font-medium">
          <AlertTriangleIcon className="size-4 text-amber-600 dark:text-amber-400" />
          Sin match en el extracto ({ids.length})
        </span>
        <Badge variant="secondary">{ids.length}</Badge>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        {ids.length === 0 ? (
          <p className="text-muted-foreground px-3 py-2 text-xs">
            Todas las transacciones del período aparecen en el extracto.
          </p>
        ) : (
          <p className="text-muted-foreground px-3 py-2 text-xs">
            Estas transacciones están en Findash pero no en el extracto — probablemente son dupes de
            SMS (retry), reversiones netted-out, o errores. Revisalas en{" "}
            <a className="underline" href="/transactions">
              /transactions
            </a>
            . No se tocan automáticamente.
            <br />
            <span className="font-mono text-xs">
              IDs: {ids.slice(0, 20).join(", ")}
              {ids.length > 20 ? ` … (+${ids.length - 20} más)` : null}
            </span>
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
