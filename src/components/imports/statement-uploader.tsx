"use client";

// Statement PDF uploader component.
//
// Handles drag-and-drop + file picker, client-side validation, preview
// rendering, and the confirm/cancel flow. Extensible for future statement
// formats via the `format` select.

import { useCallback, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { previewArqStatement, commitArqStatement } from "@/app/(app)/imports/actions";
import type {
  ImportPreviewResult,
  ImportCommitResult,
  StatementFormat,
} from "@/app/(app)/imports/_types";

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const FORMATS: { value: StatementFormat; label: string }[] = [
  { value: "arq", label: "ARQ / DolarApp" },
];

function formatCents(centsStr: string): string {
  const cents = BigInt(centsStr);
  const zero = BigInt(0);
  const hundred = BigInt(100);
  const abs = cents < zero ? -cents : cents;
  const sign = cents < zero ? "-" : "";
  const dollars = abs / hundred;
  const rem = abs % hundred;
  return `${sign}$${dollars.toLocaleString("en-US")}.${String(rem).padStart(2, "0")}`;
}

function periodLabel(start: string, _end: string): string {
  const d = new Date(start + "T12:00:00Z");
  return d.toLocaleDateString("es-CO", { month: "long", year: "numeric" });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DropZone({ onFile, disabled }: { onFile: (file: File) => void; disabled: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      if (disabled) return;
      const file = e.dataTransfer.files[0];
      if (file) onFile(file);
    },
    [onFile, disabled],
  );

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragging(false);
  }, []);

  const handleClick = () => {
    if (!disabled) inputRef.current?.click();
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onFile(file);
      // Reset input so the same file can be dropped again after cancel.
      e.target.value = "";
    }
  };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label="Zona de carga — hacé click o soltá un PDF aquí"
      aria-disabled={disabled}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") handleClick();
      }}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      className={[
        "flex min-h-40 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 transition-colors",
        dragging
          ? "border-primary bg-primary/5"
          : "border-muted-foreground/30 hover:border-primary/50 hover:bg-muted/40",
        disabled ? "pointer-events-none opacity-50" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="text-4xl" aria-hidden>
        📄
      </div>
      <p className="text-muted-foreground text-center text-sm">
        Soltá el PDF aquí o hacé click para seleccionar
      </p>
      <p className="text-muted-foreground/60 text-xs">Solo PDFs, máximo 10 MB</p>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        aria-hidden
        tabIndex={-1}
        onChange={handleChange}
      />
    </div>
  );
}

function BalanceRow({
  label,
  centsStr,
  sign,
}: {
  label: string;
  centsStr: string;
  sign?: "+" | "-";
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">
        {sign && (
          <span
            className={
              sign === "+"
                ? "mr-1 font-semibold text-emerald-600 dark:text-emerald-400"
                : "mr-1 font-semibold text-rose-600 dark:text-rose-400"
            }
          >
            {sign}
          </span>
        )}
        {label}
      </span>
      <span className="font-mono font-medium">{formatCents(centsStr)}</span>
    </div>
  );
}

function PreviewCard({
  preview,
  onConfirm,
  onCancel,
  confirming,
}: {
  preview: ImportPreviewResult;
  onConfirm: () => void;
  onCancel: () => void;
  confirming: boolean;
}) {
  const { balanceCheck, chainCheck } = preview;

  return (
    <div className="flex flex-col gap-4 rounded-xl border p-5">
      {/* Header */}
      <div>
        <h2 className="text-sm font-semibold">Cuenta detectada</h2>
        <p className="text-muted-foreground text-sm">{preview.accountLabel}</p>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Período</h2>
          <p className="text-muted-foreground text-sm">
            {periodLabel(preview.period.start, preview.period.end)}
          </p>
        </div>
        <div className="text-right">
          <h2 className="text-sm font-semibold">Transacciones</h2>
          <p className="text-muted-foreground text-sm">{preview.parsedCount}</p>
        </div>
      </div>

      {/* Balance reconciliation */}
      <div className="bg-muted/30 flex flex-col gap-2 rounded-lg p-4">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Reconciliación</h3>
          {balanceCheck.ok ? (
            <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
              Balances cuadran
            </span>
          ) : (
            <span className="text-xs font-medium text-rose-600 dark:text-rose-400">
              Balance no cuadra
            </span>
          )}
        </div>
        <BalanceRow label="Balance inicial" centsStr={balanceCheck.declaredStartCents} />
        <BalanceRow label="Ingresos" centsStr={balanceCheck.declaredCreditsCents} sign="+" />
        <BalanceRow label="Retiros" centsStr={balanceCheck.declaredDebitsCents} sign="-" />
        <div className="border-muted-foreground/20 my-1 border-t" />
        <BalanceRow label="Balance final" centsStr={balanceCheck.declaredEndCents} />

        {!balanceCheck.ok && balanceCheck.errors.length > 0 && (
          <div className="mt-2 rounded-md bg-rose-50 p-3 dark:bg-rose-950/20">
            {balanceCheck.errors.map((err, i) => (
              <p key={i} className="text-xs text-rose-700 dark:text-rose-400">
                {err}
              </p>
            ))}
          </div>
        )}

        {balanceCheck.warnings.length > 0 && (
          <div className="mt-2 rounded-md bg-amber-50 p-3 dark:bg-amber-950/20">
            {balanceCheck.warnings.map((w, i) => (
              <p key={i} className="text-xs text-amber-700 dark:text-amber-400">
                {w}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Chain check */}
      {chainCheck.chainOk === false && chainCheck.diffCents !== null && (
        <div className="flex gap-2 rounded-md bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-950/20 dark:text-amber-400">
          <span aria-hidden>⚠️</span>
          <span>
            El balance inicial de este extracto ({formatCents(chainCheck.currentStartCents)}) no
            coincide con el balance final del extracto anterior (
            {formatCents(chainCheck.previousEndCents!)}). Diferencia:{" "}
            {formatCents(chainCheck.diffCents)}.
          </span>
        </div>
      )}

      {/* Reconcile failure warning */}
      {!balanceCheck.ok && (
        <div className="flex gap-2 rounded-md bg-rose-50/80 p-3 text-xs text-rose-700 dark:bg-rose-950/20 dark:text-rose-400">
          <span aria-hidden>⚠️</span>
          <span>
            El parser no logró cuadrar los números. Si confirmás la importación, las transacciones
            NO se insertarán. El extracto quedará registrado para auditoría.{" "}
            <a
              href="https://github.com/ingamartinez/personal-financial-dashboard/issues/new"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Reportá esto con el PDF.
            </a>
          </span>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onCancel} disabled={confirming}>
          Cancelar
        </Button>
        <Button onClick={onConfirm} disabled={confirming} aria-busy={confirming}>
          {confirming ? "Importando..." : "Confirmar import"}
        </Button>
      </div>
    </div>
  );
}

function SuccessCard({ result, onReset }: { result: ImportCommitResult; onReset: () => void }) {
  const periodStr = result.period
    ? periodLabel(result.period.start, result.period.end)
    : "extracto";

  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-emerald-200 bg-emerald-50 p-8 text-center dark:border-emerald-800/30 dark:bg-emerald-950/20">
      <div className="text-4xl" aria-hidden>
        ✅
      </div>
      <div>
        <h2 className="font-semibold">Statement {periodStr} importado</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {result.insertedCount ?? 0} nuevas &bull; {result.mergedCount ?? 0} mergeadas &bull;{" "}
          {result.flaggedCount ?? 0} marcadas para revisión
        </p>
      </div>
      <Button variant="outline" onClick={onReset}>
        Importar otro extracto
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type Phase =
  | { kind: "idle" }
  | { kind: "previewing" }
  | { kind: "preview"; data: ImportPreviewResult }
  | { kind: "confirming" }
  | { kind: "done"; result: ImportCommitResult }
  | { kind: "error"; message: string };

export function StatementUploader() {
  const [format, setFormat] = useState<StatementFormat>("arq");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [_isPending, startTransition] = useTransition();

  const handleFile = useCallback(
    (file: File) => {
      // Client-side validation
      if (!file.type.includes("pdf") && !file.name.endsWith(".pdf")) {
        setPhase({ kind: "error", message: "El archivo debe ser un PDF." });
        return;
      }
      if (file.size > MAX_PDF_BYTES) {
        setPhase({
          kind: "error",
          message: `El archivo supera el límite de 10 MB (${(file.size / 1_048_576).toFixed(1)} MB).`,
        });
        return;
      }

      setPhase({ kind: "previewing" });

      startTransition(async () => {
        try {
          const formData = new FormData();
          formData.append("file", file);

          let result: ImportPreviewResult;
          if (format === "arq") {
            result = await previewArqStatement(formData);
          } else {
            setPhase({ kind: "error", message: "Formato no soportado aún." });
            return;
          }

          setPhase({ kind: "preview", data: result });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Ocurrió un error al procesar el PDF.";
          setPhase({ kind: "error", message });
        }
      });
    },
    [format],
  );

  const handleConfirm = useCallback(() => {
    if (phase.kind !== "preview") return;
    const token = phase.data.token;

    setPhase({ kind: "confirming" });

    startTransition(async () => {
      try {
        const result = await commitArqStatement(token);

        if (result.status === "committed") {
          setPhase({ kind: "done", result });
          const periodStr = result.period
            ? periodLabel(result.period.start, result.period.end)
            : "extracto";
          toast.success(
            `Statement ${periodStr} importado: ${result.insertedCount ?? 0} nuevas, ${result.mergedCount ?? 0} mergeadas, ${result.flaggedCount ?? 0} marcadas para revisión`,
          );
        } else if (result.status === "reconcile_failed") {
          setPhase({
            kind: "error",
            message:
              result.error ??
              "El parser no logró cuadrar los números. No se importó nada. Reportá esto con el PDF.",
          });
        } else if (result.status === "already_imported") {
          setPhase({ kind: "idle" });
          toast.error("Este extracto ya fue importado anteriormente.");
        } else if (result.status === "expired") {
          setPhase({ kind: "idle" });
          toast.error("La sesión expiró. Subí el PDF nuevamente.");
        } else {
          setPhase({ kind: "error", message: result.error ?? "Error desconocido." });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Error al confirmar la importación.";
        setPhase({ kind: "error", message });
      }
    });
  }, [phase]);

  const handleCancel = useCallback(() => {
    setPhase({ kind: "idle" });
  }, []);

  const handleReset = useCallback(() => {
    setPhase({ kind: "idle" });
  }, []);

  const isDropDisabled = phase.kind === "previewing" || phase.kind === "confirming";

  return (
    <div className="flex flex-col gap-6">
      {/* Format selector — extensible for future formats */}
      <div className="flex flex-col gap-1">
        <label htmlFor="statement-format" className="text-sm font-medium">
          Tipo de extracto
        </label>
        <select
          id="statement-format"
          value={format}
          onChange={(e) => setFormat(e.target.value as StatementFormat)}
          disabled={isDropDisabled || phase.kind === "preview" || phase.kind === "done"}
          className="bg-background focus:ring-ring w-full max-w-xs rounded-md border px-3 py-2 text-sm focus:ring-2 focus:outline-none disabled:opacity-50"
        >
          {FORMATS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      {/* Drop zone — only shown when not in preview/done state */}
      {(phase.kind === "idle" || phase.kind === "previewing" || phase.kind === "error") && (
        <DropZone onFile={handleFile} disabled={isDropDisabled} />
      )}

      {/* Loading state */}
      {phase.kind === "previewing" && (
        <div
          role="status"
          aria-live="polite"
          className="text-muted-foreground flex items-center gap-3 text-sm"
        >
          <div
            className="border-primary size-5 animate-spin rounded-full border-2 border-t-transparent"
            aria-hidden
          />
          Analizando el extracto...
        </div>
      )}

      {/* Error state */}
      {phase.kind === "error" && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-xl border border-rose-200 bg-rose-50 p-5 dark:border-rose-800/30 dark:bg-rose-950/20"
        >
          <p className="text-sm font-medium text-rose-700 dark:text-rose-400">{phase.message}</p>
          <p className="text-muted-foreground text-xs">
            Si el error persiste,{" "}
            <a
              href="https://github.com/ingamartinez/personal-financial-dashboard/issues/new"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              reportalo con el PDF
            </a>
            .
          </p>
          <Button variant="outline" size="sm" onClick={handleCancel} className="self-start">
            Intentar de nuevo
          </Button>
        </div>
      )}

      {/* Preview state */}
      {phase.kind === "preview" && (
        <PreviewCard
          preview={phase.data}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
          confirming={false}
        />
      )}

      {/* Confirming state */}
      {phase.kind === "confirming" && phase.kind === "confirming" && (
        <div className="flex flex-col gap-4 rounded-xl border p-5">
          <div
            role="status"
            aria-live="polite"
            className="text-muted-foreground flex items-center gap-3 text-sm"
          >
            <div
              className="border-primary size-5 animate-spin rounded-full border-2 border-t-transparent"
              aria-hidden
            />
            Importando transacciones...
          </div>
          <Button variant="outline" disabled>
            Cancelar
          </Button>
        </div>
      )}

      {/* Success state */}
      {phase.kind === "done" && <SuccessCard result={phase.result} onReset={handleReset} />}
    </div>
  );
}
