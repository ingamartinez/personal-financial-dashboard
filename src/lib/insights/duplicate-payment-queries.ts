/**
 * Duplicate payment queries for the /insights page card.
 *
 * Server-side only — no BullMQ / ioredis transitively pulled in.
 * Queried in real-time by the /insights RSC.
 */

import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { formatAccountLabel } from "@/lib/accounts/format";
import type { AnomalyFlags } from "./merchant-anomaly";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DuplicatePaymentRow = {
  newTxId: number;
  canonicalMerchant: string;
  amountCents: bigint;
  currency: string;
  occurredAt: Date;
  newAccountLabel: string;
  otherAccountLabel: string;
  pairedTxId: number;
};

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Fetch recent duplicate payment detections from the last 30 days for a user.
 *
 * Returns up to `limit` unique pairs, ordered by most recent first.
 * A "pair" is identified by (newTxId, pairedTxId) — only the new tx side is
 * surfaced since `anomaly_flags.duplicatePayment` is only written on new txs.
 *
 * @param userId  Authenticated user id.
 * @param limit   Maximum number of results (default 10).
 */
export async function fetchRecentDuplicatePayments(
  userId: number,
  limit = 10,
): Promise<DuplicatePaymentRow[]> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      id: transactions.id,
      canonicalMerchant: transactions.canonicalMerchant,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      occurredAt: transactions.occurredAt,
      accountId: transactions.accountId,
      anomalyFlags: transactions.anomalyFlags,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        notDeleted(transactions.deletedAt),
        gte(transactions.occurredAt, thirtyDaysAgo),
        isNotNull(transactions.canonicalMerchant),
        sql`${transactions.anomalyFlags} -> 'duplicatePayment' IS NOT NULL`,
      ),
    )
    .orderBy(desc(transactions.occurredAt))
    .limit(limit * 2); // over-fetch to allow dedup

  if (rows.length === 0) return [];

  // Collect all account IDs referenced (new tx + paired)
  const accountIdSet = new Set<number>();
  for (const row of rows) {
    accountIdSet.add(row.accountId);
    const flags = row.anomalyFlags as AnomalyFlags | null;
    if (flags?.duplicatePayment?.otherAccountId) {
      accountIdSet.add(flags.duplicatePayment.otherAccountId);
    }
  }

  const accountRows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      currency: accounts.currency,
      metadata: accounts.metadata,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), notDeleted(accounts.deletedAt)));

  const accountMap = new Map(accountRows.map((a) => [a.id, a]));

  const seen = new Set<string>();
  const result: DuplicatePaymentRow[] = [];

  for (const row of rows) {
    const flags = row.anomalyFlags as AnomalyFlags | null;
    if (!flags?.duplicatePayment) continue;

    const { pairedTxId, otherAccountId } = flags.duplicatePayment;
    // Dedup by canonical_merchant + pairedTxId
    const dedupKey = `${row.canonicalMerchant}:${pairedTxId}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const newAccount = accountMap.get(row.accountId);
    const otherAccount = accountMap.get(otherAccountId);

    result.push({
      newTxId: row.id,
      canonicalMerchant: row.canonicalMerchant!,
      amountCents: row.amountCents,
      currency: row.currency,
      occurredAt: row.occurredAt,
      newAccountLabel: newAccount ? formatAccountLabel(newAccount) : `cuenta ${row.accountId}`,
      otherAccountLabel: otherAccount
        ? formatAccountLabel(otherAccount)
        : `cuenta ${otherAccountId}`,
      pairedTxId,
    });

    if (result.length >= limit) break;
  }

  return result;
}
