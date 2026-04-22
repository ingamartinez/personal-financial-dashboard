import type { ParsedStatement, StatementRow } from "./types";

// Tx-shaped subset the matcher needs — the action layer is responsible for
// fetching these via drizzle. Keeping the matcher pure makes it trivial to
// unit-test without a DB.
export type TxRowForMatch = {
  id: number;
  occurredAt: Date;
  amountCents: bigint;
  merchant: string | null;
  descriptionRaw: string;
  installmentsTotal: number;
  installmentRateEmX10k: number | null;
  externalId: string | null;
};

export type TxDiff = {
  installmentsTotalBefore: number;
  installmentsTotalAfter: number;
  rateEmX10kBefore: number | null;
  rateEmX10kAfter: number | null;
};

export type MatchedRow = {
  statementRow: StatementRow;
  txId: number;
  willChange: boolean;
  diff: TxDiff;
};

export type MatchResult = {
  matched: MatchedRow[];
  // Statement rows with no corresponding tx. For `during-period` these become
  // INSERTs; `before-period` entries in here are data-integrity warnings.
  missingInLedger: StatementRow[];
  // Txs that exist in the ledger for this period but don't appear in the
  // statement — never auto-touched; surfaced so the user can investigate.
  unmatchedInLedger: TxRowForMatch[];
};

export type MatchOptions = {
  dateToleranceDays?: number;
};

// Bancolombia prints purchases with a POSITIVE sign on the extracto and
// payments/abonos with a NEGATIVE sign. Findash's ledger uses the opposite
// convention: TC expenses are stored as negative amounts, TC payments/credits
// as positive. So to compare we invert the statement sign to "ledger shape".
export function statementAmountToLedger(cents: bigint): bigint {
  return -cents;
}

const DEFAULT_DATE_TOLERANCE_DAYS = 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Colombia has no DST — UTC-5 is exact year-round. Matching by Bogota
// calendar day keeps an SMS ingested at 11 PM local from drifting into the
// next UTC day and falling outside the ±1 day window.
const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;

function bogotaDayOrdinal(date: Date): number {
  // Integer count of days since the Unix epoch in Bogota-local time.
  return Math.floor((date.getTime() - BOGOTA_OFFSET_MS) / MS_PER_DAY);
}

// INTERESES CORRIENTES is a synthetic line the bank itself prints at cycle
// cut — it's not a real purchase. Findash generates its own equivalent via
// applyInteresesCausadosForCycle, so we never INSERT or match this row.
export function isBankInterestRow(row: StatementRow): boolean {
  if (row.authorizationNumber !== null) return false;
  return /^\s*INTERESES\s+CORRIENTES\s*$/i.test(row.merchant);
}

function normalizeTokens(s: string): Set<string> {
  const cleaned = s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return new Set();
  return new Set(cleaned.split(" ").filter((t) => t.length >= 2));
}

export function merchantSimilarity(a: string, b: string): number {
  const ta = normalizeTokens(a);
  const tb = normalizeTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap += 1;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : overlap / union;
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(bogotaDayOrdinal(a) - bogotaDayOrdinal(b));
}

// Picks the most likely tx for a statement row given an exact-amount candidate
// pool (must all satisfy `amountCents === row.amountCents`). Tiebreakers:
// smaller date delta > higher merchant similarity > smaller tx id.
function pickBestCandidate(row: StatementRow, candidates: TxRowForMatch[]): TxRowForMatch {
  if (candidates.length === 1) return candidates[0];
  return candidates
    .map((tx) => ({
      tx,
      dateDelta: daysBetween(tx.occurredAt, row.occurredAt),
      similarity: merchantSimilarity(row.merchant, tx.merchant ?? tx.descriptionRaw),
    }))
    .sort((a, b) => {
      if (a.dateDelta !== b.dateDelta) return a.dateDelta - b.dateDelta;
      if (a.similarity !== b.similarity) return b.similarity - a.similarity;
      return a.tx.id - b.tx.id;
    })[0].tx;
}

function buildDiff(row: StatementRow, tx: TxRowForMatch): TxDiff {
  const total = row.installments?.total ?? 1;
  return {
    installmentsTotalBefore: tx.installmentsTotal,
    installmentsTotalAfter: total,
    rateEmX10kBefore: tx.installmentRateEmX10k,
    rateEmX10kAfter: row.rateEmX10k,
  };
}

function willChange(diff: TxDiff): boolean {
  if (diff.installmentsTotalBefore !== diff.installmentsTotalAfter) return true;
  // Rate change only counts when the statement actually reports one. A row
  // without a rate (e.g. 1/1 purchases where the bank prints 0,0000) still
  // produces a non-null rateEmX10k=0, so null means "bank didn't report"
  // and we don't overwrite.
  if (diff.rateEmX10kAfter !== null && diff.rateEmX10kBefore !== diff.rateEmX10kAfter) {
    return true;
  }
  return false;
}

export function matchStatementAgainstLedger(
  parsed: ParsedStatement,
  txs: TxRowForMatch[],
  opts: MatchOptions = {},
): MatchResult {
  const tolerance = opts.dateToleranceDays ?? DEFAULT_DATE_TOLERANCE_DAYS;
  const matched: MatchedRow[] = [];
  const missingInLedger: StatementRow[] = [];
  const pool = new Map<number, TxRowForMatch>();
  for (const tx of txs) pool.set(tx.id, tx);

  // Process statement rows in the order they appear. `during-period` rows
  // come first in the fixture, so they get first pick of ambiguous matches
  // (what you'd want: match current-cycle purchases before older ones).
  for (const row of parsed.rows) {
    if (isBankInterestRow(row)) continue;
    const ledgerAmount = statementAmountToLedger(row.amountCents);
    const candidates = Array.from(pool.values()).filter(
      (tx) =>
        tx.amountCents === ledgerAmount && daysBetween(tx.occurredAt, row.occurredAt) <= tolerance,
    );
    if (candidates.length === 0) {
      missingInLedger.push(row);
      continue;
    }
    const best = pickBestCandidate(row, candidates);
    pool.delete(best.id);
    const diff = buildDiff(row, best);
    matched.push({
      statementRow: row,
      txId: best.id,
      willChange: willChange(diff),
      diff,
    });
  }

  return {
    matched,
    missingInLedger,
    unmatchedInLedger: Array.from(pool.values()),
  };
}
