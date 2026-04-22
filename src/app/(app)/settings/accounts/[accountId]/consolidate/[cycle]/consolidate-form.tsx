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
import { ReportSection } from "./consolidate-report-view";

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
}: {
  reports: ConsolidationReport[];
  onConfirm: () => void;
  canConfirm: boolean;
  applying: boolean;
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
          <ReportSection key={`${report.accountId}-${idx}`} report={report} showHeading={isMulti} />
        ))}
      </CardContent>
    </Card>
  );
}
