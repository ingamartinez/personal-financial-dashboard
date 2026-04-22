"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangleIcon, CheckCircleIcon, PlusCircleIcon, UploadCloudIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ConsolidationReport } from "@/lib/ingestion/bancolombia-statement/consolidate";

import { commitStatementAction, previewStatementAction } from "../actions";

type Props = {
  accountId: number;
  accountName: string;
  cycle: string;
  institutionSlug: string;
};

function formatCents(str: string): string {
  if (!str) return "—";
  const big = BigInt(str);
  const negative = big < BigInt(0);
  const abs = negative ? -big : big;
  const units = abs / BigInt(100);
  const fractional = (abs % BigInt(100)).toString().padStart(2, "0");
  const unitsStr = units.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}$${unitsStr},${fractional}`;
}

function formatRate(x10k: number | null): string {
  if (x10k == null) return "—";
  const whole = Math.floor(x10k / 10_000);
  const frac = (x10k % 10_000).toString().padStart(4, "0");
  return `${whole},${frac}%`;
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "short",
    timeZone: "America/Bogota",
  }).format(new Date(iso));
}

export function ConsolidateForm({ accountId, accountName, cycle, institutionSlug }: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<ConsolidationReport | null>(null);
  const [parsing, startParsing] = useTransition();
  const [applying, startApplying] = useTransition();

  const onFileChosen = useCallback((chosen: File | null) => {
    setFile(chosen);
    setPreview(null);
  }, []);

  function handleDragOver(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragging(true);
  }
  function handleDragLeave() {
    setDragging(false);
  }
  function handleDrop(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) onFileChosen(dropped);
  }

  function runPreview() {
    if (!file) {
      toast.error("Elegí un archivo .xlsx primero.");
      return;
    }
    const fd = new FormData();
    fd.set("file", file);
    fd.set("accountId", String(accountId));
    fd.set("cycle", cycle);
    startParsing(async () => {
      try {
        const report = await previewStatementAction(fd);
        setPreview(report);
        toast.success(
          `Preview listo · ${report.matchStats.matched} matched, ${report.matchStats.insertedMissing} nuevas, ${report.matchStats.unmatchedInLedger} sin match`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Parse failed";
        if (msg.startsWith("last4_mismatch")) {
          toast.error(
            `El xlsx es de otra tarjeta. Subí el extracto correspondiente a ${accountName}.`,
          );
        } else if (msg === "unsupported_file_type") {
          toast.error("Solo soportamos .xlsx por ahora (no PDF).");
        } else if (msg === "file_too_large") {
          toast.error(
            "El archivo excede 10 MB. Bancolombia rara vez genera extractos tan grandes.",
          );
        } else {
          toast.error(msg);
        }
      }
    });
  }

  function runCommit() {
    if (!file || !preview) return;
    const fd = new FormData();
    fd.set("file", file);
    fd.set("accountId", String(accountId));
    fd.set("cycle", cycle);
    startApplying(async () => {
      try {
        const report = await commitStatementAction(fd);
        if (report.status === "already-consolidated") {
          toast.info("Ya estaba consolidado — sin cambios.");
        } else {
          toast.success(
            `Consolidado · ${report.matchStats.matched} matched, ${report.insertedTxIds.length} insertadas, intereses: ${report.intereses.status}`,
          );
        }
        setPreview(null);
        setFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Commit failed");
      }
    });
  }

  const busy = parsing || applying;
  const canConfirm =
    preview !== null &&
    preview.status === "dry-run" &&
    (preview.matchStats.matched > 0 || preview.matchStats.insertedMissing > 0);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Subí el extracto detallado (.xlsx)</CardTitle>
          <CardDescription>
            Exportá el extracto del ciclo {cycle} desde la Sucursal Virtual Bancolombia (formato
            detallado, no resumido). Institución detectada: {institutionSlug}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <label
            htmlFor="consolidate-file"
            data-testid="consolidate-dropzone"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={cn(
              "flex flex-col items-center gap-2 rounded-md border-2 border-dashed px-6 py-10 text-center transition",
              dragging
                ? "border-primary bg-primary/5"
                : "border-muted-foreground/30 hover:border-muted-foreground/60",
              busy && "pointer-events-none opacity-60",
            )}
          >
            <UploadCloudIcon className="text-muted-foreground size-8" />
            <div className="text-sm font-medium">
              {file ? file.name : "Arrastrá el xlsx aquí o click para elegir"}
            </div>
            <div className="text-muted-foreground text-xs">
              {file
                ? `${(file.size / 1024).toFixed(1)} kB · click para cambiar`
                : "Solo .xlsx · hasta 10 MB"}
            </div>
            <input
              id="consolidate-file"
              ref={fileInputRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              disabled={busy}
              onChange={(e) => onFileChosen(e.target.files?.[0] ?? null)}
            />
          </label>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="button" onClick={runPreview} disabled={!file || busy}>
              {parsing ? "Analizando…" : "Ver preview"}
            </Button>
            {file ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  onFileChosen(null);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
                disabled={busy}
              >
                Quitar archivo
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {preview ? (
        <PreviewPanel
          report={preview}
          onConfirm={runCommit}
          canConfirm={canConfirm}
          applying={applying}
        />
      ) : null}
    </div>
  );
}

function PreviewPanel({
  report,
  onConfirm,
  canConfirm,
  applying,
}: {
  report: ConsolidationReport;
  onConfirm: () => void;
  canConfirm: boolean;
  applying: boolean;
}) {
  const willChangeRows = report.matchedDiffs.filter((d) => d.willChange);
  const noChangeMatches = report.matchedDiffs.length - willChangeRows.length;
  const interesesLine =
    report.intereses.status === "inserted"
      ? `se insertará 1 tx sintética intereses-tc por ${formatCents(report.intereses.totalInterestCentsStr)}`
      : report.intereses.status === "skipped"
        ? `no se insertará tx sintética (${report.intereses.reason})`
        : `intereses se corren al confirmar (dry-run lo omite)`;

  return (
    <Card data-testid="consolidate-preview">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Preview — dry-run</CardTitle>
          <CardDescription>
            Revisá los cambios antes de confirmar. Una vez aplicado, el ciclo queda marcado como
            consolidado y cualquier re-subida se convierte en no-op.
          </CardDescription>
        </div>
        <Button type="button" onClick={onConfirm} disabled={!canConfirm || applying}>
          {applying ? "Aplicando…" : "Confirmar consolidación"}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <SummaryGrid report={report} />
        <Alert>
          <AlertTitle>Proyección de intereses</AlertTitle>
          <AlertDescription>
            Al confirmar, {interesesLine}.{" "}
            {report.intereses.status === "inserted"
              ? `Compras multi-cuota sin tasa: ${report.intereses.purchasesNeedingRate}.`
              : null}
          </AlertDescription>
        </Alert>

        <MatchesSection rows={willChangeRows} noChangeCount={noChangeMatches} />
        <MissingSection missing={report.missingInLedger} />
        <UnmatchedSection ids={report.unmatchedInLedgerIds} />
      </CardContent>
    </Card>
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
