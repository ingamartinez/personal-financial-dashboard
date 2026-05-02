/**
 * Savings suggestions queries for the /insights page card.
 *
 * Server-side only — no BullMQ / ioredis transitively pulled in.
 * Queries are called in real-time by the /insights RSC.
 *
 * Uses derivedBalanceCentsSql (snapshot-anchored) for accurate balance.
 */

import { and, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { derivedBalanceCentsSql } from "@/lib/accounts/queries";
import { formatAccountLabel } from "@/lib/accounts/format";
import { getCurrentFxRate } from "@/lib/fx/repo";
import {
  detectIdleSavings,
  computeCdtSuggestion,
  computeFicSuggestion,
  SAVINGS_WINDOW_DAYS,
} from "./savings-suggestions";
import { CDT_RATES, FIC_YIELD } from "./cdt-fic-rates";
import type { Currency } from "@/lib/types";
import type { CdtSuggestion, FicSuggestion } from "./savings-suggestions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SavingsSuggestionRow = {
  accountId: number;
  accountLabel: string;
  avgBalanceCents: bigint;
  currency: Currency;
  cdt: CdtSuggestion | null;
  fic: FicSuggestion | null;
};

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Fetch CDT + FIC savings suggestions for the /insights card.
 *
 * Returns an array of per-account rows. Empty array means no idle savings
 * detected — the card should not be rendered.
 *
 * @param userId  Authenticated user id.
 */
export async function fetchSavingsSuggestion(userId: number): Promise<SavingsSuggestionRow[]> {
  const fx = await getCurrentFxRate();
  const fxRate = fx.rate;

  // Fetch savings accounts with derived balance
  const accountRows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      currency: accounts.currency,
      institution: accounts.institution,
      metadata: accounts.metadata,
      type: accounts.type,
      balanceCents: derivedBalanceCentsSql,
    })
    .from(accounts)
    .where(
      and(eq(accounts.userId, userId), eq(accounts.active, true), notDeleted(accounts.deletedAt)),
    );

  if (accountRows.length === 0) return [];

  // Fetch last 90d transactions
  const ninetyDaysAgo = new Date(Date.now() - SAVINGS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const txRows = await db
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

  const accountsForDetection = accountRows.map((row) => ({
    id: row.id,
    type: row.type,
    currency: row.currency as Currency,
    balanceCents: BigInt(row.balanceCents),
  }));

  const txsForDetection = txRows.map((row) => ({
    accountId: row.accountId,
    amountCents: row.amountCents,
    currency: row.currency as Currency,
  }));

  const idleAccounts = detectIdleSavings({
    accounts: accountsForDetection,
    txsLast90d: txsForDetection,
    fxRate,
  });

  if (idleAccounts.length === 0) return [];

  const accountMap = new Map(accountRows.map((a) => [a.id, a]));

  return idleAccounts.map((idleAccount) => {
    const accountRow = accountMap.get(idleAccount.accountId)!;
    const accountLabel = formatAccountLabel(accountRow);

    return {
      accountId: idleAccount.accountId,
      accountLabel,
      avgBalanceCents: idleAccount.avgBalanceCents,
      currency: idleAccount.currency,
      cdt: computeCdtSuggestion(idleAccount, CDT_RATES),
      fic: computeFicSuggestion(idleAccount, FIC_YIELD),
    };
  });
}
