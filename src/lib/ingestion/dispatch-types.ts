// Unified ingestion dispatcher — shared types.
//
// NO "use server" directive: this file exports only types/interfaces, which are
// non-async by definition. Next.js 16 server-action files reject non-async
// exports, so all types must live in sibling files like this one.
// (Memory: nextjs16-server-action-types-split)

import type { RawStatement } from "./arq-statement/types";
// The savings/extracto/tc-legacy parsers live in reconciliation/parsers and
// return their own ParsedStatement (bank, format, periodStart, rowCount, rows).
import type { ParsedStatement as ReconciliationParsedStatement } from "@/lib/reconciliation/parsers/types";
// The tc-detallado parser lives in bancolombia-statement and returns a
// richer ParsedStatement that includes account metadata and period dates.
import type { ParsedStatement as BancolombiaStatementParsed } from "./bancolombia-statement/types";

// ---------------------------------------------------------------------------
// IngestionKind
// ---------------------------------------------------------------------------

export type IngestionKind =
  | "arq-pdf"
  | "bancolombia-savings" // 4-col Movimientos
  | "bancolombia-extracto" // 6-col Extracto Mensual with SALDO column
  | "bancolombia-tc-legacy" // 6-col TC (legacy reconcile path)
  | "bancolombia-tc-detallado"; // PESOS+DOLARES sheets, consolidate path

// ---------------------------------------------------------------------------
// Hint types
// ---------------------------------------------------------------------------

export interface AccountHint {
  accountId: number;
  /** How the hint was derived — used for logging and UI annotation. */
  source: "file-header" | "query-string" | "user-override";
}

export interface CycleHint {
  /** YYYY-MM format, derived from the file's parsed period. */
  cycle: string;
  source: "file-period" | "query-string" | "user-override";
}

// ---------------------------------------------------------------------------
// DispatchResult — discriminated union by kind
// ---------------------------------------------------------------------------
//
// Each branch carries:
//   - kind: the detected IngestionKind
//   - accountHint: resolved from file-internal metadata (null if not found)
//   - cycleHint: only for tc-detallado (the only kind with a meaningful cycle)
//   - format-specific parsed payload ready for the commit pipeline
//
// "format_unknown" is a sentinel: XLSX read succeeded but no format matched.
// The UI presents a manual kind-picker; it is NOT part of IngestionKind because
// it represents the absence of a detected kind, not a known ingestion format.

export type DispatchResult =
  | {
      kind: "arq-pdf";
      rawStatement: RawStatement;
      accountHint: AccountHint | null;
    }
  | {
      kind: "bancolombia-savings";
      /** ParsedStatement from reconciliation/parsers/bancolombia-savings */
      parsed: ReconciliationParsedStatement;
      accountHint: AccountHint | null;
    }
  | {
      kind: "bancolombia-extracto";
      /** ParsedStatement from reconciliation/parsers/bancolombia-savings-extracto */
      parsed: ReconciliationParsedStatement;
      accountHint: AccountHint | null;
    }
  | {
      kind: "bancolombia-tc-legacy";
      /** ParsedStatement from reconciliation/parsers/bancolombia-tc */
      parsed: ReconciliationParsedStatement;
      accountHint: AccountHint | null;
    }
  | {
      kind: "bancolombia-tc-detallado";
      /** ParsedStatements from bancolombia-statement/xlsx — COP first, USD second. */
      parsedSheets: BancolombiaStatementParsed[];
      /** True when both PESOS and DOLARES sheets were present in the workbook. */
      multiCurrencySheets: boolean;
      cycleHint: CycleHint;
      accountHint: AccountHint | null;
    }
  | { kind: "format_unknown" };

// Re-export for callers that need to reference these types alongside DispatchResult.
export type { RawStatement, ReconciliationParsedStatement, BancolombiaStatementParsed };
