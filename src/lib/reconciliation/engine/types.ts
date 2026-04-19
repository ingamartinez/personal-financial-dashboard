import type { ParsedStatementRow } from "../parsers/types";

/**
 * Shape the engine expects for an existing transaction when deciding
 * matches. The caller (upload endpoint) projects the full tx row into
 * this subset. `amountCents` is SIGNED per findash's DB convention:
 * positive = ingreso, negative = gasto.
 */
export interface ExistingTxnForMatch {
  id: number;
  occurredAt: Date;
  amountCents: bigint;
  currency: "COP" | "USD";
  descriptionRaw: string;
  merchant: string | null;
  channel: "bank" | "manual" | "transfer";
  isAdjustment: boolean;
  reconciliationStatus: "unreconciled" | "matched" | "flagged" | "imported_from_statement";
}

export type MatchAction = "match" | "insert_new";
export type MatchReason = "amount_date_exact" | "amount_date_fuzzy_merchant" | "no_match";

export interface MatchDecision {
  statementRowIndex: number;
  action: MatchAction;
  matchedTxnId: number | null;
  matchScore: number;
  matchReason: MatchReason;
}

export interface FlaggedExistingTxn {
  txnId: number;
  reason: "no_statement_match";
}

export interface MatchingPlan {
  decisions: MatchDecision[];
  flaggedExisting: FlaggedExistingTxn[];
  summary: {
    matched: number;
    newInserts: number;
    flaggedExisting: number;
  };
}

export interface MatchingConfig {
  dateToleranceDays?: number;
  merchantFuzzThreshold?: number;
}

export interface MatchingInput {
  parsedRows: ParsedStatementRow[];
  existingTxns: ExistingTxnForMatch[];
  config?: MatchingConfig;
}
