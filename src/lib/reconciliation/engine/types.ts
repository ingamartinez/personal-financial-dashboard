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

export type MatchAction = "match" | "insert_new" | "near_match";
export type MatchReason =
  | "amount_date_exact"
  | "amount_date_fuzzy_merchant"
  | "near_match_fuzzy_amount"
  | "no_match";

export interface MatchDecision {
  statementRowIndex: number;
  action: MatchAction;
  /**
   * For action='match': the consumed existing txn id.
   * For action='near_match': the candidate existing txn id (NOT consumed —
   *   candidate still flows to flaggedExisting post-Apply; the user resolves
   *   via the merge-into action from #301).
   * For action='insert_new': null.
   */
  matchedTxnId: number | null;
  matchScore: number;
  matchReason: MatchReason;
  /**
   * Populated only for near-match decisions so the preview UI can annotate
   * the diff without re-deriving it from candidate + parsed row. Serialized
   * as string since MatchingPlan crosses the RSC boundary intact.
   */
  amountDiffCents?: string;
  dateDiffDays?: number;
  descriptionSimilarity?: number;
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
    nearMatches: number;
    flaggedExisting: number;
  };
}

export interface MatchingConfig {
  dateToleranceDays?: number;
  merchantFuzzThreshold?: number;
  /**
   * Tunable thresholds for the near-match fallback pass. The amount
   * threshold is max(absoluteCopFloorCents | absoluteUsdFloorCents,
   * amount × percentTolerance). `descriptionSimilarityMin` applies to the
   * overlap coefficient (|A ∩ B| / min(|A|, |B|)) rather than jaccard —
   * chosen so asymmetric bank-vs-SMS descriptions are not penalized for
   * the bank's longer prefix.
   */
  nearMatch?: {
    dateToleranceDays?: number;
    descriptionSimilarityMin?: number;
    minTokensInSmallerSet?: number;
    amountFloorCopCents?: bigint;
    amountFloorUsdCents?: bigint;
    amountPercentTolerance?: number;
  };
}

export interface MatchingInput {
  parsedRows: ParsedStatementRow[];
  existingTxns: ExistingTxnForMatch[];
  config?: MatchingConfig;
  /**
   * The statement's declared period. When provided, flaggedExisting is
   * restricted to existingTxns whose occurredAt falls inside it — so a
   * Bancolombia April XLSX upload doesn't surface end-of-March txs as
   * flagged just because the matcher's expand window pulled them in.
   */
  period?: { start: Date; end: Date };
}
