// Unified import UI types for /imports page.
//
// NO "use server" directive: this file exports only types/interfaces and a Zod
// schema — all non-async. Next.js 16 server-action files reject non-async
// exports, so these must live in a sibling file like this one.
// (Memory: nextjs16-server-action-types-split, nextjs16-use-server-async-only)

import { z } from "zod";

// Re-export IngestionKind so UI modules only need to import from this file.
export type { IngestionKind } from "@/lib/ingestion/dispatch-types";

// ---------------------------------------------------------------------------
// Hint query-string schema (zod) — validated on the server page
// ---------------------------------------------------------------------------

export const hintSchema = z.object({
  hint_account_id: z.coerce.number().int().positive().optional(),
  hint_cycle: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  // #760 — when "1", bypass the already-consolidated guard in the commit step.
  force: z
    .string()
    .optional()
    .transform((v) => v === "1"),
  // #906 — the format the user picked by hand after detection returned
  // format_unknown. An enum, not a free string: this value selects a parser, so
  // anything outside the known set is rejected here rather than reaching
  // parseAndHint as an unhandled kind.
  manual_kind: z
    .enum([
      "arq-pdf",
      "bancolombia-savings",
      "bancolombia-extracto",
      "bancolombia-tc-legacy",
      "bancolombia-tc-detallado",
    ])
    .optional(),
});

export type HintParams = z.infer<typeof hintSchema>;

// ---------------------------------------------------------------------------
// Manual-kind compatibility (#906)
// ---------------------------------------------------------------------------

/**
 * The account type each kind can be committed against, for a **manually
 * forced** kind only.
 *
 * Why forced-only: auto-detected kinds have always been allowed through
 * whatever account the user picked, and tightening that here would reject
 * imports that work today. The force path is new, so it gets the strict rule
 * without breaking anything behind it.
 *
 * Why it needs a rule at all: `bancolombia-tc-detallado` routes to
 * `consolidateCycleFromStatement`, which reads `account.type` to choose date
 * tolerances and credit context but — verified while writing #906 — never
 * *refuses* a savings account. So without this, forcing a TC format onto a
 * savings account is accepted and silently consolidates with credit-card
 * semantics against an account that has none.
 *
 * `arq-pdf` is unconstrained on purpose: ARQ accounts resolve by institution,
 * not by type, and there is no equivalent mis-route to guard against.
 */
export const MANUAL_KIND_ACCOUNT_TYPES: Record<
  IngestionKindValue,
  readonly ("savings" | "credit_card" | "loan")[] | null
> = {
  "arq-pdf": null,
  "bancolombia-savings": ["savings"],
  "bancolombia-extracto": ["savings"],
  "bancolombia-tc-legacy": ["credit_card"],
  "bancolombia-tc-detallado": ["credit_card"],
};

type IngestionKindValue =
  | "arq-pdf"
  | "bancolombia-savings"
  | "bancolombia-extracto"
  | "bancolombia-tc-legacy"
  | "bancolombia-tc-detallado";

// ---------------------------------------------------------------------------
// ImportPreviewResultV2 — discriminated union by kind
// ---------------------------------------------------------------------------
//
// Each variant carries:
//   token         — UUID for the single-use commit step
//   kind          — detected IngestionKind
//   accountLabel  — formatted account name (via formatAccountLabel)
//   period        — { start, end } ISO date strings
//   multiCurrency — present for tc-detallado when both PESOS + DOLARES sheets
//                   were found; includes siblingAccountLabel
//
// BigInts are serialized as strings (JSON safety).

export interface MultiCurrencyInfo {
  siblingAccountId: number;
  siblingAccountLabel: string;
  rowsByCurrency: {
    COP: number;
    USD: number;
  };
}

// Shared base fields present in every preview variant
interface PreviewBase {
  token: string;
  accountLabel: string;
  period: {
    start: string; // ISO date string YYYY-MM-DD
    end: string;
  };
}

// ARQ PDF preview — includes balance + chain check
export interface ArqPreviewResult extends PreviewBase {
  kind: "arq-pdf";
  parsedCount: number;
  balanceCheck: {
    ok: boolean;
    declaredStartCents: string;
    declaredEndCents: string;
    declaredCreditsCents: string;
    declaredDebitsCents: string;
    parsedSumCents: string;
    diffCents: string;
    errors: string[];
    warnings: string[];
  };
  chainCheck: {
    chainOk: boolean | null;
    previousEndCents: string | null;
    currentStartCents: string;
    diffCents: string | null;
  };
  mergePreview: {
    parsedCount: number;
    estimatedMergeCount: number;
  };
  errors: string[];
}

// Bancolombia savings 4-col preview
export interface BancolombiaPreviewResult extends PreviewBase {
  kind: "bancolombia-savings" | "bancolombia-extracto" | "bancolombia-tc-legacy";
  rowCount: number;
  matched: number;
  newInserts: number;
  nearMatches: number;
  flaggedExisting: number;
  fileHash: string;
  /** Present when the XLSX has mixed COP+USD rows dispatched to two accounts. */
  multiCurrency: MultiCurrencyInfo | null;
}

// TC detallado preview — multi-currency, cycle-aware
export interface TcDetalladoPreviewResult extends PreviewBase {
  kind: "bancolombia-tc-detallado";
  cycle: string; // YYYY-MM derived from file
  reports: SerializableConsolidationReport[];
  multiCurrency: MultiCurrencyInfo | null;
}

// format_unknown — no format matched; needs manual kind picker
export interface FormatUnknownResult {
  kind: "format_unknown";
  needsManualKindPick: true;
}

export type ImportPreviewResultV2 =
  ArqPreviewResult | BancolombiaPreviewResult | TcDetalladoPreviewResult | FormatUnknownResult;

// ---------------------------------------------------------------------------
// UnifiedCommitResult — discriminated union by kind
// ---------------------------------------------------------------------------

export interface UnifiedCommitResultBase {
  status: "committed" | "already_imported" | "expired" | "error";
  error?: string;
}

export interface ArqCommitResult extends UnifiedCommitResultBase {
  kind: "arq-pdf";
  importId?: number;
  insertedCount?: number;
  mergedCount?: number;
  flaggedCount?: number;
  emailOrphanCount?: number;
  period?: { start: string; end: string };
}

export interface BancolombiaCommitResult extends UnifiedCommitResultBase {
  kind: "bancolombia-savings" | "bancolombia-extracto" | "bancolombia-tc-legacy";
  inserted?: number;
  matched?: number;
  flagged?: number;
}

export interface TcDetalladoCommitResult extends UnifiedCommitResultBase {
  kind: "bancolombia-tc-detallado";
  cycle?: string;
  sheets?: Array<{
    accountId: number;
    accountLabel: string;
    inserted: number;
    matched: number;
  }>;
}

export type UnifiedCommitResult =
  ArqCommitResult | BancolombiaCommitResult | TcDetalladoCommitResult;

// ---------------------------------------------------------------------------
// SerializableConsolidationReport — JSON-safe subset of ConsolidationReport
// ---------------------------------------------------------------------------

export interface SerializableConsolidationReport {
  accountId: number;
  accountLabel: string;
  cycle: string;
  status: string;
  matchStats: {
    matched: number;
    matchedWillChange: number;
    insertedMissing: number;
    unmatchedInLedger: number;
  };
  intereses: {
    status: string;
    txId?: number;
    reason?: string;
  };
}
