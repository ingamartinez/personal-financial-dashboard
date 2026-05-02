/**
 * Savings suggestions — C.1 CDT + C.2 FIC (Epic I, #721).
 *
 * Idle-savings detector:
 *   Identifies savings accounts with large idle balances that are NOT being
 *   drained (inflows > outflows over 90d). For qualifying accounts, computes
 *   CDT and FIC suggestions with estimated yields.
 *
 * Quarterly dedup:
 *   entityId = "{cdt|fic}-suggestion:{userId}:Q{1..4}-{YYYY}"
 *   One notification per type per quarter per user.
 *
 * Pure functions exported for unit tests (no DB, no side-effects).
 * `runSavingsSuggestionForUser` is the DB-driven entry point.
 */

import { and, eq, gte } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import { accounts, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { toCop } from "@/lib/money";
import { formatCop } from "@/lib/money";
import { derivedBalanceCentsSql } from "@/lib/accounts/queries";
import { emitNotification } from "@/lib/notifications/emit";
import { canAccessFeature } from "@/lib/auth/can-access-feature";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { CDT_RATES, FIC_YIELD } from "./cdt-fic-rates";
import { createLogger } from "@/lib/logger";
import type { Currency } from "@/lib/types";

const log = createLogger({ module: "insights/savings-suggestions" });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum average balance (COP) to consider an account idle — 5M COP. */
export const IDLE_BALANCE_THRESHOLD_CENTS = BigInt(5_000_000 * 100);

/** Minimum CDT amount (COP) to be worth suggesting — 1M COP. */
export const MIN_CDT_AMOUNT_CENTS = BigInt(1_000_000 * 100);

/** Number of days in the look-back window. */
export const SAVINGS_WINDOW_DAYS = 90;

// ---------------------------------------------------------------------------
// Pure types
// ---------------------------------------------------------------------------

export type IdleSavingsAccount = {
  accountId: number;
  /** Latest balance (cents in account currency) — used as avgBalanceCents. */
  avgBalanceCents: bigint;
  currency: Currency;
  /** abs(sum(outflow_90d)) / 3 — monthly burn estimate. */
  monthlyBurnCents: bigint;
};

export type CdtTerm = {
  months: 6 | 12 | 24;
  ratePct: number;
  estimatedYieldCents: bigint;
};

export type CdtSuggestion = {
  accountId: number;
  suggestedAmountCents: bigint;
  terms: CdtTerm[];
};

export type FicSuggestion = {
  accountId: number;
  suggestedAmountCents: bigint;
  ratePct: number;
  estimatedYearlyYieldCents: bigint;
};

// ---------------------------------------------------------------------------
// Pure — quarterly entityId
// ---------------------------------------------------------------------------

/**
 * Returns the quarter string for a given date, e.g. "Q2-2026".
 * month is 0-indexed (JS Date.getMonth()).
 */
export function quarterLabel(date: Date): string {
  const q = Math.floor(date.getMonth() / 3) + 1;
  return `Q${q}-${date.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// Pure — idle savings detection
// ---------------------------------------------------------------------------

type AccountRow = {
  id: number;
  type: string;
  currency: Currency;
  balanceCents: bigint;
};

type TxRow = {
  accountId: number;
  amountCents: bigint;
  currency: Currency;
};

/**
 * Detects idle savings accounts from the provided account list and 90-day
 * transaction history.
 *
 * NOTE: `avgBalanceCents` is the account's latest balance (from DB derivation),
 * not a true daily mean. The spec allows this simplification — it's documented
 * in the function signature and good enough for the quarterly cadence of this
 * signal.
 *
 * FX conversion: amounts in non-COP currency are converted to COP for the
 * threshold check. The returned `avgBalanceCents` is in the account's NATIVE
 * currency so the card can render the correct value.
 *
 * @param accounts  All accounts for the user.
 * @param txsLast90d  All transactions from the last 90 days for the user.
 * @param fxRate  Current COP/USD rate (from getCurrentFxRate().rate).
 */
export function detectIdleSavings({
  accounts,
  txsLast90d,
  fxRate,
}: {
  accounts: AccountRow[];
  txsLast90d: TxRow[];
  fxRate: number;
}): IdleSavingsAccount[] {
  const savingsAccounts = accounts.filter((a) => a.type === "savings");
  if (savingsAccounts.length === 0) return [];

  const result: IdleSavingsAccount[] = [];

  for (const account of savingsAccounts) {
    const avgBalanceCents = account.balanceCents;

    // Convert to COP for threshold check
    const balanceCop = toCop(avgBalanceCents, account.currency, fxRate);
    if (balanceCop <= IDLE_BALANCE_THRESHOLD_CENTS) continue;

    // Sum inflows and outflows for this account over 90d
    let inflowCents = BigInt(0);
    let outflowCents = BigInt(0);

    for (const tx of txsLast90d) {
      if (tx.accountId !== account.id) continue;
      const amountCop = toCop(tx.amountCents, tx.currency, fxRate);
      if (amountCop > BigInt(0)) {
        inflowCents += amountCop;
      } else {
        outflowCents += amountCop; // negative
      }
    }

    // Account must NOT be drained — inflows must exceed outflows
    if (inflowCents <= -outflowCents) continue;

    // monthlyBurn = abs(sum(outflow_90d)) / 3
    const absOutflow = -outflowCents; // positive
    const monthlyBurnCents = absOutflow / BigInt(3);

    result.push({
      accountId: account.id,
      avgBalanceCents,
      currency: account.currency,
      monthlyBurnCents,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Pure — CDT suggestion
// ---------------------------------------------------------------------------

/**
 * Computes a CDT suggestion for an idle savings account.
 *
 * suggestedAmount = avgBalance - 1.5 × monthlyBurn (keep buffer)
 * Returns null if suggestedAmount < MIN_CDT_AMOUNT_CENTS (not worth suggesting).
 *
 * Yield formula (BigInt-only):
 *   estimatedYieldCents = suggestedAmount × round(ratePct × 1000) × months / 12_000
 *
 * The ×1000 / ÷12_000 trick scales the fraction so we stay in BigInt domain.
 * For a 12.5% rate: round(0.125 × 1000) = 125; yield = principal × 125 × 12 / 12_000.
 */
export function computeCdtSuggestion(
  idleAccount: IdleSavingsAccount,
  rates: typeof CDT_RATES,
): CdtSuggestion | null {
  const buffer = (BigInt(15) * idleAccount.monthlyBurnCents) / BigInt(10); // 1.5 × monthly
  const suggestedAmountCents = idleAccount.avgBalanceCents - buffer;

  if (suggestedAmountCents < MIN_CDT_AMOUNT_CENTS) return null;

  const termEntries: Array<[6 | 12 | 24, number]> = [
    [6, rates.months6],
    [12, rates.months12],
    [24, rates.months24],
  ];

  const terms: CdtTerm[] = termEntries.map(([months, ratePct]) => {
    // Yield computation uses the raw fraction from CDT_RATES directly.
    const rateScaled = BigInt(Math.round(ratePct * 1000));
    const estimatedYieldCents =
      (suggestedAmountCents * rateScaled * BigInt(months)) / BigInt(12_000);
    // ratePct stored in 0..100 form to match FicSuggestion.ratePct domain.
    return { months, ratePct: ratePct * 100, estimatedYieldCents };
  });

  return {
    accountId: idleAccount.accountId,
    suggestedAmountCents,
    terms,
  };
}

// ---------------------------------------------------------------------------
// Pure — FIC suggestion
// ---------------------------------------------------------------------------

/**
 * Computes a FIC suggestion for an idle savings account.
 *
 * Same buffer logic as CDT — same suggested amount.
 * FIC is liquid so yield is annual (no lock-in period).
 *
 * Yield formula:
 *   estimatedYearlyYieldCents = suggestedAmount × round(FIC_YIELD × 1000) / 1_000
 */
export function computeFicSuggestion(
  idleAccount: IdleSavingsAccount,
  ficYield: number,
): FicSuggestion | null {
  const buffer = (BigInt(15) * idleAccount.monthlyBurnCents) / BigInt(10);
  const suggestedAmountCents = idleAccount.avgBalanceCents - buffer;

  if (suggestedAmountCents < MIN_CDT_AMOUNT_CENTS) return null;

  const yieldScaled = BigInt(Math.round(ficYield * 1000));
  const estimatedYearlyYieldCents = (suggestedAmountCents * yieldScaled) / BigInt(1_000);

  return {
    accountId: idleAccount.accountId,
    suggestedAmountCents,
    ratePct: ficYield * 100, // e.g. 0.08 → 8
    estimatedYearlyYieldCents,
  };
}

// ---------------------------------------------------------------------------
// DB-driven entry point
// ---------------------------------------------------------------------------

/**
 * Run CDT + FIC savings suggestion checks for one user.
 *
 * - Fetches current balances (latest balance from accounts.balance_cents field)
 *   and the last 90 days of transactions.
 * - Applies detectIdleSavings, computeCdtSuggestion, computeFicSuggestion.
 * - Emits quarterly-deduped notifications (one CDT + one FIC per quarter).
 * - Gated by canAccessFeature independently for CDT and FIC.
 *
 * Called fire-and-forget from cash-flow-daily worker.
 */
export async function runSavingsSuggestionForUser(
  userId: number,
  database: DB = defaultDb,
  /** Pre-fetched FX rate from the calling worker. When omitted, fetched here. */
  cachedFxRate?: number,
): Promise<void> {
  const ninetyDaysAgo = new Date(Date.now() - SAVINGS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const now = new Date();

  // Use caller-provided FX rate when available to avoid a redundant DB query
  // per-user (the cash-flow-daily worker already fetches it once for all users).
  const fxRate =
    cachedFxRate !== undefined ? cachedFxRate : (await getCurrentFxRate(database)).rate;

  // Fetch savings accounts with snapshot-anchored derived balance
  const accountRows = await database
    .select({
      id: accounts.id,
      type: accounts.type,
      currency: accounts.currency,
      balanceCents: derivedBalanceCentsSql,
    })
    .from(accounts)
    .where(
      and(eq(accounts.userId, userId), notDeleted(accounts.deletedAt), eq(accounts.active, true)),
    );

  const accountsForDetection: AccountRow[] = accountRows.map((row) => ({
    id: row.id,
    type: row.type,
    currency: row.currency as Currency,
    balanceCents: BigInt(row.balanceCents),
  }));

  // Fetch last 90d transactions
  const txRows = await database
    .select({
      accountId: transactions.accountId,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        notDeleted(transactions.deletedAt),
        gte(transactions.occurredAt, ninetyDaysAgo),
      ),
    );

  const txsForDetection: TxRow[] = txRows.map((row) => ({
    accountId: row.accountId,
    amountCents: row.amountCents,
    currency: row.currency as Currency,
  }));

  const idleAccounts = detectIdleSavings({
    accounts: accountsForDetection,
    txsLast90d: txsForDetection,
    fxRate,
  });

  if (idleAccounts.length === 0) {
    log.debug({ userId, event: "savings_suggestion_no_idle" }, "no idle savings accounts found");
    return;
  }

  const qLabel = quarterLabel(now);

  const [canCdt, canFic] = await Promise.all([
    canAccessFeature(userId, "cdt-suggestion"),
    canAccessFeature(userId, "fic-suggestion"),
  ]);

  for (const idleAccount of idleAccounts) {
    if (canCdt) {
      const cdtSuggestion = computeCdtSuggestion(idleAccount, CDT_RATES);
      if (cdtSuggestion) {
        // Use the 12M term for the notification body (most common reference)
        const term12 = cdtSuggestion.terms.find((t) => t.months === 12);
        const yieldStr = term12 ? formatCop(term12.estimatedYieldCents) : "";
        const amountStr = formatCop(cdtSuggestion.suggestedAmountCents);

        emitNotification(userId, {
          type: "cdt_suggestion",
          entityId: `cdt-suggestion:${userId}:${qLabel}`,
          title: "Ahorros sin trabajar",
          body: `Tenés ${amountStr} idle. CDT 12M te rendiría ~${yieldStr} extra al año. Ojo: estimación, consultá tu banco.`,
          priority: "low",
          metadata: {
            accountId: idleAccount.accountId,
            suggestedAmountCents: String(cdtSuggestion.suggestedAmountCents),
            quarterLabel: qLabel,
          },
        }).catch((err: unknown) => {
          log.error(
            { err, userId, event: "cdt_suggestion_emit_failed" },
            "failed to emit cdt_suggestion notification",
          );
        });

        log.info(
          { userId, accountId: idleAccount.accountId, qLabel, event: "cdt_suggestion_emitted" },
          "CDT suggestion emitted",
        );
      }
    }

    if (canFic) {
      const ficSuggestion = computeFicSuggestion(idleAccount, FIC_YIELD);
      if (ficSuggestion) {
        const yieldStr = formatCop(ficSuggestion.estimatedYearlyYieldCents);
        const amountStr = formatCop(ficSuggestion.suggestedAmountCents);

        emitNotification(userId, {
          type: "fic_suggestion",
          entityId: `fic-suggestion:${userId}:${qLabel}`,
          title: "FIC: rendimiento con liquidez inmediata",
          body: `Tenés ${amountStr} idle. FIC te rendiría ~${yieldStr} al año con liquidez inmediata. Ojo: estimación, consultá tu banco.`,
          priority: "low",
          metadata: {
            accountId: idleAccount.accountId,
            suggestedAmountCents: String(ficSuggestion.suggestedAmountCents),
            quarterLabel: qLabel,
          },
        }).catch((err: unknown) => {
          log.error(
            { err, userId, event: "fic_suggestion_emit_failed" },
            "failed to emit fic_suggestion notification",
          );
        });

        log.info(
          { userId, accountId: idleAccount.accountId, qLabel, event: "fic_suggestion_emitted" },
          "FIC suggestion emitted",
        );
      }
    }
  }
}
