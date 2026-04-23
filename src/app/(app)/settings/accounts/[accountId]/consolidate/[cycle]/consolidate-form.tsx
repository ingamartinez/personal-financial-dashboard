"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UploadCloudIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ConsolidationReport } from "@/lib/ingestion/bancolombia-statement/consolidate";

import { commitStatementAction, previewStatementAction } from "../actions";
import { isMultiReport, type ConsolidateActionResult } from "../consolidate-types";
import { formatCents, ReportSection } from "./consolidate-report-view";
import { parseSignedAmountToCents } from "./parse-saldo-real";

type Props = {
  accountId: number;
  accountName: string;
  cycle: string;
  institutionSlug: string;
};

function toReportList(result: ConsolidateActionResult): ConsolidationReport[] {
  return isMultiReport(result) ? result.reports : [result];
}

function sumMatched(reports: ConsolidationReport[]): number {
  return reports.reduce((a, r) => a + r.matchStats.matched, 0);
}
function sumInserted(reports: ConsolidationReport[]): number {
  return reports.reduce((a, r) => a + r.matchStats.insertedMissing, 0);
}
function sumUnmatched(reports: ConsolidationReport[]): number {
  return reports.reduce((a, r) => a + r.matchStats.unmatchedInLedger, 0);
}

export function ConsolidateForm({ accountId, accountName, cycle, institutionSlug }: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<ConsolidateActionResult | null>(null);
  // #433 — per-account saldo-real input keyed by accountId. Empty string ==
  // "user didn't fill it" → we don't send anything for that account.
  const [saldoRealInputs, setSaldoRealInputs] = useState<Record<number, string>>({});
  const [parsing, startParsing] = useTransition();
  const [applying, startApplying] = useTransition();

  const onFileChosen = useCallback((chosen: File | null) => {
    setFile(chosen);
    setPreview(null);
    setSaldoRealInputs({});
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
        const result = await previewStatementAction(fd);
        setPreview(result);
        const reports = toReportList(result);
        const suffix =
          reports.length > 1
            ? ` · ${reports.length} hojas (${reports.map((r) => r.accountId).join(", ")})`
            : "";
        toast.success(
          `Preview listo · ${sumMatched(reports)} matched, ${sumInserted(reports)} nuevas, ${sumUnmatched(reports)} sin match${suffix}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Parse failed";
        if (msg.startsWith("last4_mismatch")) {
          toast.error(
            `El xlsx es de otra tarjeta. Subí el extracto correspondiente a ${accountName}.`,
          );
        } else if (msg.startsWith("currency_mismatch")) {
          toast.error(
            `La moneda del extracto no coincide con la cuenta (${accountName}). Subí el extracto correcto.`,
          );
        } else if (msg.startsWith("missing_usd_sibling")) {
          toast.error(
            "El xlsx incluye la hoja DOLARES pero esta tarjeta no tiene una sub-cuenta USD linkeada. Creala desde Cuentas → Tarjetas físicas.",
          );
        } else if (msg.startsWith("missing_cop_sibling")) {
          toast.error(
            "El xlsx incluye la hoja PESOS pero no hay una sub-cuenta COP linkeada a este plástico.",
          );
        } else if (msg === "multi_sheet_without_physical_card") {
          toast.error(
            "El xlsx es multi-moneda (PESOS + DOLARES) pero esta cuenta no está asociada a una tarjeta física. Asocíala primero.",
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
    // #433 — parse each account's saldo-real input into cents and attach.
    // Empty → skipped. Invalid → block the commit and surface a toast.
    for (const [rawAccountId, rawValue] of Object.entries(saldoRealInputs)) {
      const parsed = parseSignedAmountToCents(rawValue);
      if (parsed === undefined) continue; // empty field
      if (parsed === null) {
        toast.error(
          `No pude leer el saldo real de la cuenta #${rawAccountId}. Usá números (con . o , opcional).`,
        );
        return;
      }
      fd.set(`saldoRealLedgerCents_${rawAccountId}`, parsed.toString());
    }
    startApplying(async () => {
      try {
        const result = await commitStatementAction(fd);
        const reports = toReportList(result);
        const allAlreadyConsolidated = reports.every((r) => r.status === "already-consolidated");
        if (allAlreadyConsolidated) {
          toast.info("Ya estaba consolidado — sin cambios.");
        } else {
          const insertedTotal = reports.reduce((a, r) => a + r.insertedTxIds.length, 0);
          const interesesSummary = reports.map((r) => r.intereses.status).join(" / ");
          const suffix = reports.length > 1 ? ` (${reports.length} hojas)` : "";
          toast.success(
            `Consolidado · ${sumMatched(reports)} matched, ${insertedTotal} insertadas, intereses: ${interesesSummary}${suffix}`,
          );
        }
        setPreview(null);
        setFile(null);
        setSaldoRealInputs({});
        if (fileInputRef.current) fileInputRef.current.value = "";
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Commit failed");
      }
    });
  }

  const busy = parsing || applying;
  const previewReports = preview ? toReportList(preview) : [];
  const canConfirm =
    previewReports.length > 0 &&
    previewReports.some(
      (r) =>
        r.status === "dry-run" && (r.matchStats.matched > 0 || r.matchStats.insertedMissing > 0),
    );

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
          reports={previewReports}
          onConfirm={runCommit}
          canConfirm={canConfirm}
          applying={applying}
          saldoRealInputs={saldoRealInputs}
          onSaldoRealChange={(reportAccountId, value) =>
            setSaldoRealInputs((prev) => ({ ...prev, [reportAccountId]: value }))
          }
        />
      ) : null}
    </div>
  );
}

function PreviewPanel({
  reports,
  onConfirm,
  canConfirm,
  applying,
  saldoRealInputs,
  onSaldoRealChange,
}: {
  reports: ConsolidationReport[];
  onConfirm: () => void;
  canConfirm: boolean;
  applying: boolean;
  saldoRealInputs: Record<number, string>;
  onSaldoRealChange: (accountId: number, value: string) => void;
}) {
  const isMulti = reports.length > 1;
  return (
    <Card data-testid="consolidate-preview">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Preview — dry-run</CardTitle>
          <CardDescription>
            {isMulti
              ? "El extracto trae varias hojas. Al confirmar aplicamos la consolidación a cada cuenta asociada."
              : "Revisá los cambios antes de confirmar. Una vez aplicado, el ciclo queda marcado como consolidado y cualquier re-subida se convierte en no-op."}
          </CardDescription>
        </div>
        <Button type="button" onClick={onConfirm} disabled={!canConfirm || applying}>
          {applying ? "Aplicando…" : "Confirmar consolidación"}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {reports.map((report, idx) => (
          <div key={`${report.accountId}-${idx}`} className="flex flex-col gap-3">
            <ReportSection report={report} showHeading={isMulti} />
            <SaldoRealInput
              report={report}
              value={saldoRealInputs[report.accountId] ?? ""}
              onChange={(v) => onSaldoRealChange(report.accountId, v)}
              disabled={applying}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// #433 — per-account "saldo real" input. Rendered BELOW each ReportSection
// in the preview panel so the user can eyeball the projected saldo first,
// then decide whether to override it. Empty field == "accept the projected
// delta" (no plug inserted). Non-empty is parsed at submit time via
// `parseSignedAmountToCents`.
function SaldoRealInput({
  report,
  value,
  onChange,
  disabled,
}: {
  report: ConsolidationReport;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const projected = report.projection?.saldoProyectadoCentsStr;
  const parsed = parseSignedAmountToCents(value);
  const isInvalid = parsed === null; // undefined (empty) is fine
  const parsedLedger = typeof parsed === "bigint" ? parsed : null;

  // Diff vs. projected so the user knows a plug will be inserted.
  let plugPreview: string | null = null;
  if (parsedLedger !== null && projected) {
    const diff = parsedLedger - BigInt(projected);
    if (diff !== BigInt(0)) {
      plugPreview = `Se insertará un ajuste de ${formatCents(diff.toString())} para que el saldo quede exactamente en ${formatCents(parsedLedger.toString())}.`;
    } else {
      plugPreview = "El saldo real coincide con el proyectado — no se insertará ningún ajuste.";
    }
  }

  const placeholder = projected ? formatCents(projected) : "—";
  const inputId = `saldo-real-${report.accountId}`;

  return (
    <div
      data-testid={`saldo-real-input-${report.accountId}`}
      className="bg-muted/30 flex flex-col gap-2 rounded-md border border-dashed p-3 text-sm"
    >
      <label htmlFor={inputId} className="font-medium">
        ¿Cuál es tu saldo real según el banco?{" "}
        <span className="text-muted-foreground text-xs font-normal">
          (opcional — dejá vacío para aceptar el delta proyectado)
        </span>
      </label>
      <input
        id={inputId}
        type="text"
        inputMode="decimal"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "border-input focus-visible:ring-ring rounded-md border bg-transparent px-3 py-2 tabular-nums focus-visible:ring-2 focus-visible:ring-offset-0 focus-visible:outline-none",
          isInvalid && "border-destructive",
        )}
        data-testid={`saldo-real-field-${report.accountId}`}
      />
      {isInvalid ? (
        <p className="text-destructive text-xs">
          Formato no válido. Usá un número (ej: -1.543.000,00 o -1543000.00).
        </p>
      ) : plugPreview ? (
        <p className="text-muted-foreground text-xs">{plugPreview}</p>
      ) : (
        <p className="text-muted-foreground text-xs">
          Si el saldo que ves en el banco difiere del proyectado, entralo acá y al confirmar se
          inserta un ajuste de saldo para cuadrar. Puede estar compensando compras que Findash nunca
          vio o plugs viejos obsoletos — andá a /reconcile a revisar después.
        </p>
      )}
    </div>
  );
}
