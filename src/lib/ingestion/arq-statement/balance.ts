// ARQ statement balance reconciliation invariant + inter-month chain check.
//
// This module provides the quality gate that must pass before any statement's
// transactions are committed to the database. It is a pure, DB-free layer —
// all DB interaction lives in run-statement-import.ts.
//
// References:
//   - Issue #515 (Epic ARQ sub-issue C)
//   - Memory: ingestion/arq-statement-discovery (invariants verified on 3 real PDFs)

import { createLogger } from "@/lib/logger";

import type { ParsedStatementTx } from "./type-handlers";
import type { RawStatement } from "./types";

const log = createLogger({ module: "arq-statement-balance" });

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  ok: boolean;
  declaredStartCents: bigint;
  declaredEndCents: bigint;
  declaredCreditsCents: bigint;
  declaredDebitsCents: bigint;
  parsedSumCents: bigint;
  parsedCreditsCents: bigint;
  parsedDebitsCents: bigint;
  /** Calculated end minus declared end (signed). Zero when ok=true (within tolerance). */
  diffCents: bigint;
  errors: string[];
  warnings: string[];
}

/**
 * Result of comparing the opening balance of the current statement against
 * the closing balance of the previously-imported statement.
 *
 * chainOk=null means no previous statement was found for this
 * (user_id, account_id) pair — valid for the first import.
 */
export interface ChainCheck {
  chainOk: boolean | null;
  previousEndCents: bigint | null;
  currentStartCents: bigint;
  diffCents: bigint | null;
}

// ---------------------------------------------------------------------------
// reconcileStatement — single-statement hard gate
// ---------------------------------------------------------------------------

/**
 * Verify the balance invariant for a single ARQ statement.
 *
 * Algorithm:
 *   1. Filter out `kind: 'skip'` entries — they carry no amount to sum.
 *   2. parsedCredits = sum of amountUsdc where amountUsdc > 0
 *   3. parsedDebits  = sum of |amountUsdc| where amountUsdc < 0
 *   4. parsedSum     = parsedCredits − parsedDebits  (net)
 *   5. calcEnd       = declaredStart + parsedSum
 *   6. Hard gate: |calcEnd − declaredEnd| ≤ 1 cent  → ok=true.
 *   7. Cross-check declared totals: |parsedCredits − declaredCredits| ≤ 1
 *      and |parsedDebits − declaredDebits| ≤ 1 — failures append to errors.
 *
 * Callers (runStatementImport) abort and do not insert any transactions when
 * ok=false. The full ReconcileResult is persisted to arq_statement_imports for
 * auditability regardless.
 */
export function reconcileStatement(
  parsed: RawStatement,
  txs: ParsedStatementTx[],
): ReconcileResult {
  const { summary, accountNumber, periodStart, periodEnd } = parsed.header;
  const {
    balanceStartCents: declaredStartCents,
    balanceEndCents: declaredEndCents,
    totalCreditsCents: declaredCreditsCents,
    totalDebitsCents: declaredDebitsCents,
  } = summary;

  const errors: string[] = [];
  const warnings: string[] = [];

  // Step 1: filter skips
  const active = txs.filter((tx) => tx.kind !== "skip");

  // Steps 2-4: accumulate signed amounts
  let parsedCreditsCents = BigInt(0);
  let parsedDebitsCents = BigInt(0);

  for (const tx of active) {
    // TypeScript narrows: skip is excluded by the filter above, every other
    // variant has amountUsdc.
    const amt = (tx as { amountUsdc: bigint }).amountUsdc;
    if (amt > BigInt(0)) {
      parsedCreditsCents += amt;
    } else if (amt < BigInt(0)) {
      parsedDebitsCents += -amt; // store as positive
    }
    // zero-amount tx: counts as parsed but contributes nothing to either bucket
  }

  const parsedSumCents = parsedCreditsCents - parsedDebitsCents;

  // Step 5: expected closing balance
  const calcEndCents = declaredStartCents + parsedSumCents;

  // Step 6: hard gate — ±1 cent tolerance for rounding
  const diffCents = calcEndCents - declaredEndCents;
  const absDiff = diffCents < BigInt(0) ? -diffCents : diffCents;
  const endBalanceOk = absDiff <= BigInt(1);

  if (!endBalanceOk) {
    errors.push(
      `Statement balance reconciliation failed for ARQ ${accountNumber}, ` +
        `period ${periodStart.toISOString().slice(0, 10)}..${periodEnd.toISOString().slice(0, 10)}: ` +
        `declared_start=${fmtCents(declaredStartCents)} ` +
        `declared_credits=${fmtCents(declaredCreditsCents)} ` +
        `declared_debits=${fmtCents(declaredDebitsCents)} ` +
        `declared_end=${fmtCents(declaredEndCents)} ` +
        `parsed_credits=${fmtCents(parsedCreditsCents)} ` +
        `parsed_debits=${fmtCents(parsedDebitsCents)} ` +
        `calc_end=${fmtCents(calcEndCents)} ` +
        `diff=${fmtCents(diffCents)}`,
    );
  }

  // Step 7: cross-check declared totals (independent of end-balance check)
  const creditDiff =
    parsedCreditsCents - declaredCreditsCents < BigInt(0)
      ? declaredCreditsCents - parsedCreditsCents
      : parsedCreditsCents - declaredCreditsCents;
  if (creditDiff > BigInt(1)) {
    errors.push(
      `Credits mismatch for ARQ ${accountNumber}: ` +
        `declared=${fmtCents(declaredCreditsCents)} parsed=${fmtCents(parsedCreditsCents)} ` +
        `diff=${fmtCents(parsedCreditsCents - declaredCreditsCents)}`,
    );
  }

  const debitDiff =
    parsedDebitsCents - declaredDebitsCents < BigInt(0)
      ? declaredDebitsCents - parsedDebitsCents
      : parsedDebitsCents - declaredDebitsCents;
  if (debitDiff > BigInt(1)) {
    errors.push(
      `Debits mismatch for ARQ ${accountNumber}: ` +
        `declared=${fmtCents(declaredDebitsCents)} parsed=${fmtCents(parsedDebitsCents)} ` +
        `diff=${fmtCents(parsedDebitsCents - declaredDebitsCents)}`,
    );
  }

  const ok = errors.length === 0;

  const event = ok ? "arq_statement_reconcile_pass" : "arq_statement_reconcile_fail";
  const logEntry = {
    event,
    accountNumber,
    period: `${periodStart.toISOString().slice(0, 10)}..${periodEnd.toISOString().slice(0, 10)}`,
    declaredStartCents: String(declaredStartCents),
    declaredEndCents: String(declaredEndCents),
    declaredCreditsCents: String(declaredCreditsCents),
    declaredDebitsCents: String(declaredDebitsCents),
    parsedCreditsCents: String(parsedCreditsCents),
    parsedDebitsCents: String(parsedDebitsCents),
    calcEndCents: String(calcEndCents),
    diffCents: String(diffCents),
    parsedCount: active.length,
    skippedCount: txs.length - active.length,
    errors,
    warnings,
  };

  if (ok) {
    log.info(logEntry, "ARQ statement balance reconciliation passed");
  } else {
    log.error(logEntry, "ARQ statement balance reconciliation failed");
  }

  return {
    ok,
    declaredStartCents,
    declaredEndCents,
    declaredCreditsCents,
    declaredDebitsCents,
    parsedSumCents,
    parsedCreditsCents,
    parsedDebitsCents,
    diffCents,
    errors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// buildChainCheck — inter-month soft warn (pure, DB-free)
// ---------------------------------------------------------------------------

/**
 * Compare the current statement's opening balance against the previous
 * statement's closing balance.
 *
 * Callers pass `previousEndCents` from a DB query; this function stays pure
 * so it can be tested without a DB. The chainOk flag is written to
 * arq_statement_imports but does NOT abort the import — it is a soft warn.
 *
 * Possible outcomes:
 *   - previousEndCents=null   → chainOk=null   (first statement for this account)
 *   - match within ±1 cent   → chainOk=true
 *   - mismatch               → chainOk=false   (gap or correction — warn, don't abort)
 */
export function buildChainCheck(
  currentStatement: RawStatement,
  previousEndCents: bigint | null,
): ChainCheck {
  const currentStartCents = currentStatement.header.summary.balanceStartCents;
  const { accountNumber, periodStart } = currentStatement.header;

  if (previousEndCents === null) {
    log.debug(
      { event: "arq_statement_chain_no_prior", accountNumber },
      "no prior statement — chain check skipped (first import)",
    );
    return {
      chainOk: null,
      previousEndCents: null,
      currentStartCents,
      diffCents: null,
    };
  }

  const rawDiff = currentStartCents - previousEndCents;
  const absDiff = rawDiff < BigInt(0) ? -rawDiff : rawDiff;
  const chainOk = absDiff <= BigInt(1);

  const logEntry = {
    event: chainOk ? "arq_statement_chain_ok" : "arq_statement_chain_mismatch",
    accountNumber,
    periodStart: periodStart.toISOString().slice(0, 10),
    previousEndCents: String(previousEndCents),
    currentStartCents: String(currentStartCents),
    diffCents: String(rawDiff),
  };

  if (chainOk) {
    log.info(logEntry, "ARQ statement chain check passed");
  } else {
    log.warn(
      logEntry,
      "ARQ statement chain mismatch — possible gap between statements or retroactive correction",
    );
  }

  return {
    chainOk,
    previousEndCents,
    currentStartCents,
    diffCents: rawDiff,
  };
}

// ---------------------------------------------------------------------------
// Formatting helper (internal only)
// ---------------------------------------------------------------------------

/** Format bigint cents as a human-readable dollar amount string (e.g. $2,542.46). */
function fmtCents(cents: bigint): string {
  const sign = cents < BigInt(0) ? "-" : "";
  const abs = cents < BigInt(0) ? -cents : cents;
  const dollars = abs / BigInt(100);
  const remainder = abs % BigInt(100);
  return `${sign}$${dollars.toLocaleString("en-US")}.${String(remainder).padStart(2, "0")}`;
}
