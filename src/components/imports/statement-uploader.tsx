"use client";

// Unified statement uploader — Phase 2 rewrite.
//
// A single drop-zone accepts both PDF and XLSX. After drop, calls
// previewIngestion which auto-detects the format. Preview panel shows:
//   - Format badge (detected kind)
//   - Account dropdown (ALWAYS visible — pre-filled from hint/detection)
//   - Cycle input (ONLY for bancolombia-tc-detallado)
//   - Multi-currency banner when applicable
//   - Per-kind detail (ARQ: balance + chain check; Bancolombia: match counts)
//   - Manual format picker ONLY when kind === "format_unknown"
//
// formatAccountLabel is always used — never inline account.name.
// (Memory: prod-accounts-seeded-2026-04-19, formatAccountLabel-must-not-inline-account-name)

import { useCallback, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { previewIngestion, commitIngestion } from "@/app/(app)/imports/actions";
import { formatAccountLabel } from "@/lib/accounts/format";
import { FormatBadge } from "./format-badge";

import type {
  ImportPreviewResultV2,
  UnifiedCommitResult,
  IngestionKind,
  ArqPreviewResult,
  BancolombiaPreviewResult,
  TcDetalladoPreviewResult,
} from "@/app/(app)/imports/_dispatch-ui-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AccountOption = {
  id: number;
  name: string;
  currency: string;
  institution?: string | null;
  metadata?: { last4s?: string[] | null } | null;
  physicalCardId?: string | null;
};

type UploaderProps = {
  accounts: AccountOption[];
  initialHint?: {
    accountId?: number;
    cycle?: string;
    // #760 — when true, the commit step will bypass the already-consolidated
    // guard and upsert the existing statement_imports row.
    force?: boolean;
  };
};

type Phase =
  | { kind: "idle" }
  | { kind: "previewing" }
  | { kind: "preview"; data: ImportPreviewResultV2 }
  | { kind: "confirming" }
  | { kind: "done"; result: UnifiedCommitResult }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const MANUAL_KIND_OPTIONS: { value: IngestionKind; label: string }[] = [
  { value: "arq-pdf", label: "ARQ PDF" },
  { value: "bancolombia-savings", label: "Bancolombia Movimientos (4 col)" },
  { value: "bancolombia-extracto", label: "Bancolombia Extracto Mensual (6 col)" },
  { value: "bancolombia-tc-legacy", label: "Bancolombia TC Legacy" },
  { value: "bancolombia-tc-detallado", label: "Bancolombia TC Detallado" },
];

// ---------------------------------------------------------------------------
// DropZone
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

  const handleDragLeave = useCallback(() => setDragging(false), []);

  const handleClick = () => {
    if (!disabled) inputRef.current?.click();
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onFile(file);
      e.target.value = "";
    }
  };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label="Zona de carga — hacé click o soltá un archivo aquí"
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
        Soltá el archivo aquí o hacé click para seleccionar
      </p>
      <p className="text-muted-foreground/60 text-xs">PDF o XLSX · PDF máx 10 MB · XLSX máx 5 MB</p>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.xlsx,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="sr-only"
        aria-hidden
        tabIndex={-1}
        onChange={handleChange}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// AccountDropdown helpers
// ---------------------------------------------------------------------------

type AccountDropdownOption =
  | {
      kind: "single";
      account: AccountOption;
    }
  | {
      kind: "group";
      physicalCardId: string;
      /** Primary leg (COP when both COP+USD exist, otherwise whichever comes first) */
      primary: AccountOption;
      label: string;
    };

/**
 * Collapses multi-currency legs (same physical_card_id) into one option.
 * Single-currency or ungrouped accounts render as-is with formatAccountLabel.
 *
 * The primary leg for a group is the COP leg when one exists; otherwise the
 * first leg in order. The backend already discovers the sibling via
 * physicalCardId when the primary account_id is submitted — this is path A.
 */
function buildDropdownOptions(accounts: AccountOption[]): AccountDropdownOption[] {
  const options: AccountDropdownOption[] = [];
  const seen = new Map<string, AccountDropdownOption & { kind: "group" }>();

  for (const a of accounts) {
    if (a.physicalCardId) {
      const existing = seen.get(a.physicalCardId);
      if (existing) {
        // Prefer COP leg as primary so the backend resolves COP→USD sibling
        if (existing.primary.currency !== "COP" && a.currency === "COP") {
          existing.primary = a;
          existing.label = a.name;
        }
        // Label stays as primary.name (no currency suffix — the xlsx covers both)
      } else {
        const entry: AccountDropdownOption & { kind: "group" } = {
          kind: "group",
          physicalCardId: a.physicalCardId,
          primary: a,
          label: a.name,
        };
        seen.set(a.physicalCardId, entry);
        options.push(entry);
      }
    } else {
      options.push({ kind: "single", account: a });
    }
  }

  return options;
}

// ---------------------------------------------------------------------------
// AccountDropdown
// ---------------------------------------------------------------------------

function AccountDropdown({
  accounts,
  value,
  onChange,
  disabled,
}: {
  accounts: AccountOption[];
  value: number | null;
  onChange: (id: number | null) => void;
  disabled: boolean;
}) {
  const options = buildDropdownOptions(accounts);

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="uploader-account" className="text-sm font-medium">
        Cuenta
      </label>
      <select
        id="uploader-account"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        disabled={disabled}
        className="bg-background focus:ring-ring w-full rounded-md border px-3 py-2 text-sm focus:ring-2 focus:outline-none disabled:opacity-50"
      >
        <option value="">Seleccioná una cuenta...</option>
        {options.map((opt) => {
          if (opt.kind === "group") {
            return (
              <option key={`pc-${opt.physicalCardId}`} value={opt.primary.id}>
                {opt.label}
              </option>
            );
          }
          return (
            <option key={opt.account.id} value={opt.account.id}>
              {formatAccountLabel(opt.account)}
            </option>
          );
        })}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ARQ preview detail
// ---------------------------------------------------------------------------

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

function ArqPreviewDetail({ preview }: { preview: ArqPreviewResult }) {
  const { balanceCheck, chainCheck } = preview;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Transacciones</span>
        <span className="font-medium">{preview.parsedCount}</span>
      </div>
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
      {chainCheck.chainOk === false && chainCheck.diffCents !== null && (
        <div className="flex gap-2 rounded-md bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-950/20 dark:text-amber-400">
          <span aria-hidden>⚠️</span>
          <span>
            El balance inicial ({formatCents(chainCheck.currentStartCents)}) no coincide con el
            balance final del extracto anterior ({formatCents(chainCheck.previousEndCents!)}).
            Diferencia: {formatCents(chainCheck.diffCents)}.
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bancolombia preview detail
// ---------------------------------------------------------------------------

function BancolombiaPreviewDetail({ preview }: { preview: BancolombiaPreviewResult }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Badge variant="outline" className="bg-emerald-50 text-emerald-900">
        {preview.matched} matched
      </Badge>
      <Badge variant="outline" className="bg-sky-50 text-sky-900">
        {preview.newInserts} nuevas
      </Badge>
      {preview.nearMatches > 0 && (
        <Badge variant="outline" className="bg-amber-50 text-amber-900">
          {preview.nearMatches} near-match
        </Badge>
      )}
      <Badge variant="outline" className="bg-amber-50 text-amber-900">
        {preview.flaggedExisting} marcadas
      </Badge>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TC Detallado preview detail
// ---------------------------------------------------------------------------

function TcDetalladoPreviewDetail({ preview }: { preview: TcDetalladoPreviewResult }) {
  return (
    <div className="flex flex-col gap-3">
      {preview.reports.map((r) => (
        <div key={r.accountId} className="rounded-lg border p-3 text-sm">
          <div className="mb-2 font-medium">{r.accountLabel}</div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className="bg-emerald-50 text-emerald-900">
              {r.matchStats.matched} matched
            </Badge>
            <Badge variant="outline" className="bg-sky-50 text-sky-900">
              {r.matchStats.insertedMissing} insertar
            </Badge>
            <Badge variant="outline" className="text-muted-foreground">
              {r.matchStats.unmatchedInLedger} sin match
            </Badge>
          </div>
          <p className="text-muted-foreground mt-2 text-xs">
            Intereses: {r.intereses.status}
            {r.intereses.txId ? ` (tx ${r.intereses.txId})` : ""}
            {r.intereses.reason ? ` — ${r.intereses.reason}` : ""}
          </p>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Multi-currency banner
// ---------------------------------------------------------------------------

function MultiCurrencyBanner({
  info,
}: {
  info: NonNullable<(BancolombiaPreviewResult | TcDetalladoPreviewResult)["multiCurrency"]>;
}) {
  return (
    <Alert className="border-sky-400/40 bg-sky-50 dark:bg-sky-950/40">
      <AlertDescription className="text-sm text-sky-900 dark:text-sky-200">
        <strong>Tarjeta multi-moneda detectada.</strong> Se aplicará a {info.rowsByCurrency.COP} fil
        {info.rowsByCurrency.COP === 1 ? "a" : "as"} COP + {info.rowsByCurrency.USD} fil
        {info.rowsByCurrency.USD === 1 ? "a" : "as"} USD → {info.siblingAccountLabel}
      </AlertDescription>
    </Alert>
  );
}

// ---------------------------------------------------------------------------
// SuccessCard
// ---------------------------------------------------------------------------

function SuccessCard({ result, onReset }: { result: UnifiedCommitResult; onReset: () => void }) {
  if (result.kind === "arq-pdf") {
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
            {result.flaggedCount ?? 0} marcadas
          </p>
        </div>
        <Button variant="outline" onClick={onReset}>
          Importar otro extracto
        </Button>
      </div>
    );
  }

  if (result.kind === "bancolombia-tc-detallado") {
    return (
      <div className="flex flex-col items-center gap-4 rounded-xl border border-emerald-200 bg-emerald-50 p-8 text-center dark:border-emerald-800/30 dark:bg-emerald-950/20">
        <div className="text-4xl" aria-hidden>
          ✅
        </div>
        <div>
          <h2 className="font-semibold">Ciclo {result.cycle} consolidado</h2>
          {result.sheets &&
            result.sheets.map((s) => (
              <p key={s.accountId} className="text-muted-foreground mt-1 text-sm">
                {s.accountLabel}: {s.inserted} insertadas, {s.matched} matched
              </p>
            ))}
        </div>
        <Button variant="outline" onClick={onReset}>
          Importar otro extracto
        </Button>
      </div>
    );
  }

  // Bancolombia savings/extracto/tc-legacy
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-emerald-200 bg-emerald-50 p-8 text-center dark:border-emerald-800/30 dark:bg-emerald-950/20">
      <div className="text-4xl" aria-hidden>
        ✅
      </div>
      <div>
        <h2 className="font-semibold">Extracto aplicado</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {result.inserted ?? 0} insertadas &bull; {result.matched ?? 0} matched &bull;{" "}
          {result.flagged ?? 0} marcadas
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

export function StatementUploader({ accounts, initialHint }: UploaderProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(
    initialHint?.accountId ?? null,
  );
  const [cycleInput, setCycleInput] = useState<string>(initialHint?.cycle ?? "");
  // #760 — force flag comes from hint (URL query param ?force=1). Stable for
  // the lifetime of the component — the page is server-rendered so the prop
  // never changes after initial mount.
  const [force] = useState<boolean>(initialHint?.force ?? false);
  const [manualKind, setManualKind] = useState<IngestionKind | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [_isPending, startTransition] = useTransition();

  const triggerPreview = useCallback(
    (file: File, overrideAccountId?: number | null) => {
      setPendingFile(file);
      setPhase({ kind: "previewing" });

      startTransition(async () => {
        try {
          const formData = new FormData();
          formData.append("file", file);
          if (overrideAccountId != null) {
            formData.append("hint_account_id", String(overrideAccountId));
          } else if (selectedAccountId != null) {
            formData.append("hint_account_id", String(selectedAccountId));
          }
          if (cycleInput) {
            formData.append("hint_cycle", cycleInput);
          }

          const result = await previewIngestion(formData);
          setPhase({ kind: "preview", data: result });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Ocurrió un error al procesar el archivo.";
          setPhase({ kind: "error", message });
        }
      });
    },
    [selectedAccountId, cycleInput],
  );

  const handleFile = useCallback(
    (file: File) => {
      triggerPreview(file);
    },
    [triggerPreview],
  );

  const handleAccountChange = useCallback(
    (newAccountId: number | null) => {
      setSelectedAccountId(newAccountId);
      // Re-preview with new account hint if we already have a file
      if (pendingFile) {
        triggerPreview(pendingFile, newAccountId);
      }
    },
    [pendingFile, triggerPreview],
  );

  const handleConfirm = useCallback(() => {
    if (phase.kind !== "preview") return;
    const data = phase.data;
    if (data.kind === "format_unknown" || !data.token) return;

    const token = data.token;
    setPhase({ kind: "confirming" });

    startTransition(async () => {
      try {
        const result = await commitIngestion(token, {
          ...(selectedAccountId ? { accountId: selectedAccountId } : {}),
          ...(force ? { force: true } : {}),
        });

        if (result.status === "committed") {
          setPhase({ kind: "done", result });
          if (result.kind === "arq-pdf") {
            const periodStr = result.period
              ? periodLabel(result.period.start, result.period.end)
              : "extracto";
            toast.success(
              `Statement ${periodStr} importado: ${result.insertedCount ?? 0} nuevas, ${result.mergedCount ?? 0} mergeadas`,
            );
          } else if (result.kind === "bancolombia-tc-detallado") {
            toast.success(`Ciclo ${result.cycle} consolidado.`);
          } else {
            toast.success(
              `Extracto aplicado: ${result.inserted ?? 0} insertadas, ${result.matched ?? 0} matched`,
            );
          }
        } else if (result.status === "already_imported") {
          setPhase({ kind: "idle" });
          toast.info("Este extracto ya fue importado anteriormente.");
        } else if (result.status === "expired") {
          setPhase({ kind: "idle" });
          toast.error("La sesión de preview expiró. Subí el archivo nuevamente.");
        } else {
          setPhase({ kind: "error", message: result.error ?? "Error desconocido." });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Error al confirmar la importación.";
        setPhase({ kind: "error", message });
      }
    });
  }, [phase, selectedAccountId, force]);

  const handleCancel = useCallback(() => {
    setPhase({ kind: "idle" });
    setPendingFile(null);
  }, []);

  const handleReset = useCallback(() => {
    setPhase({ kind: "idle" });
    setPendingFile(null);
    setManualKind(null);
  }, []);

  const isDropDisabled = phase.kind === "previewing" || phase.kind === "confirming";
  const showDropZone =
    phase.kind === "idle" || phase.kind === "previewing" || phase.kind === "error";

  const previewData = phase.kind === "preview" ? phase.data : null;
  const isFormatUnknown = previewData?.kind === "format_unknown";

  return (
    <div className="flex flex-col gap-6">
      {/* Account dropdown — ALWAYS visible (design Decision #4) */}
      <AccountDropdown
        accounts={accounts}
        value={selectedAccountId}
        onChange={handleAccountChange}
        disabled={isDropDisabled}
      />

      {/* Cycle input — ONLY for tc-detallado */}
      {(previewData?.kind === "bancolombia-tc-detallado" ||
        (phase.kind === "idle" && initialHint?.cycle)) && (
        <div className="flex flex-col gap-1">
          <label htmlFor="uploader-cycle" className="text-sm font-medium">
            Ciclo (YYYY-MM)
          </label>
          <input
            id="uploader-cycle"
            type="month"
            value={cycleInput}
            onChange={(e) => setCycleInput(e.target.value)}
            disabled={isDropDisabled}
            className="bg-background focus:ring-ring w-full max-w-xs rounded-md border px-3 py-2 text-sm focus:ring-2 focus:outline-none disabled:opacity-50"
          />
        </div>
      )}

      {/* Drop zone */}
      {showDropZone && <DropZone onFile={handleFile} disabled={isDropDisabled} />}

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
          <Button variant="outline" size="sm" onClick={handleCancel} className="self-start">
            Intentar de nuevo
          </Button>
        </div>
      )}

      {/* Preview panel */}
      {phase.kind === "preview" && previewData && (
        <div className="flex flex-col gap-4 rounded-xl border p-5">
          {/* Kind badge header */}
          <div className="flex items-center gap-2">
            {previewData.kind !== "format_unknown" ? (
              <>
                <FormatBadge kind={previewData.kind} />
                <span className="text-muted-foreground text-sm">
                  {periodLabel(previewData.period.start, previewData.period.end)}
                </span>
              </>
            ) : (
              <span className="text-sm font-medium text-amber-700">Formato no reconocido</span>
            )}
          </div>

          {/* Multi-currency banner */}
          {previewData.kind !== "format_unknown" &&
            previewData.kind !== "arq-pdf" &&
            previewData.multiCurrency && <MultiCurrencyBanner info={previewData.multiCurrency} />}

          {/* Manual kind picker for format_unknown */}
          {isFormatUnknown && (
            <div className="flex flex-col gap-1">
              <label htmlFor="uploader-manual-kind" className="text-sm font-medium">
                Seleccioná el formato manualmente
              </label>
              <select
                id="uploader-manual-kind"
                value={manualKind ?? ""}
                onChange={(e) => setManualKind((e.target.value as IngestionKind) || null)}
                className="bg-background focus:ring-ring w-full rounded-md border px-3 py-2 text-sm focus:ring-2 focus:outline-none"
              >
                <option value="">Seleccioná un formato...</option>
                {MANUAL_KIND_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Per-kind detail */}
          {previewData.kind === "arq-pdf" && <ArqPreviewDetail preview={previewData} />}
          {(previewData.kind === "bancolombia-savings" ||
            previewData.kind === "bancolombia-extracto" ||
            previewData.kind === "bancolombia-tc-legacy") && (
            <BancolombiaPreviewDetail preview={previewData} />
          )}
          {previewData.kind === "bancolombia-tc-detallado" && (
            <TcDetalladoPreviewDetail preview={previewData} />
          )}

          {/* Buttons */}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={handleCancel}>
              Cancelar
            </Button>
            {!isFormatUnknown && previewData.token && (
              <Button onClick={handleConfirm} data-testid="confirm-import-button">
                Subir
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Confirming state */}
      {phase.kind === "confirming" && (
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
            Importando...
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
