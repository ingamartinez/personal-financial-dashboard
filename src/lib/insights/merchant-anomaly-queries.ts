/**
 * Merchant anomaly queries for the /insights page card.
 *
 * Server-side only — no BullMQ / ioredis transitively pulled in.
 * Queried in real-time by the /insights RSC.
 */

import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import type { AnomalyFlags } from "./merchant-anomaly";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AnomalyKind = "anomaly" | "first_encounter";

export type RecentAnomalyRow = {
  txId: number;
  canonicalMerchant: string;
  amountCents: bigint;
  currency: string;
  occurredAt: Date;
  kind: AnomalyKind;
  /** For anomaly kind: the factor (e.g. 3.5) */
  factor: number | null;
  /** For anomaly kind: the delta from baseline, serialized as string */
  deltaCents: string | null;
  /** For anomaly kind: the baseline avg, serialized as string */
  baselineAvgCents: string | null;
};

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Fetch the most recent anomaly signals from the last 7 days for a user.
 *
 * Groups conceptually by (canonical_merchant, kind) and returns the most
 * recent entry per group, capped at 10 results.
 *
 * @param userId   Authenticated user id.
 * @param limit    Maximum number of results (default 10).
 */
export async function fetchRecentAnomalies(
  userId: number,
  limit = 10,
): Promise<RecentAnomalyRow[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      id: transactions.id,
      canonicalMerchant: transactions.canonicalMerchant,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      occurredAt: transactions.occurredAt,
      anomalyFlags: transactions.anomalyFlags,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        isNotNull(transactions.anomalyFlags),
        notDeleted(transactions.deletedAt),
        gte(transactions.occurredAt, sevenDaysAgo),
        isNotNull(transactions.canonicalMerchant),
      ),
    )
    .orderBy(desc(transactions.occurredAt))
    .limit(limit * 2); // over-fetch to allow dedup by merchant+kind

  // Dedup: keep only the most recent row per (canonicalMerchant, kind).
  // The query already orders by occurredAt DESC so first-seen wins.
  const seen = new Set<string>();
  const result: RecentAnomalyRow[] = [];

  for (const row of rows) {
    const flags = row.anomalyFlags as AnomalyFlags | null;
    if (!flags) continue;

    const kind: AnomalyKind = flags.firstEncounter ? "first_encounter" : "anomaly";
    const dedupKey = `${row.canonicalMerchant}:${kind}`;

    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    result.push({
      txId: row.id,
      canonicalMerchant: row.canonicalMerchant!,
      amountCents: row.amountCents,
      currency: row.currency,
      occurredAt: row.occurredAt,
      kind,
      factor: flags.anomaly?.factor ?? null,
      deltaCents: flags.anomaly?.deltaCents ?? null,
      baselineAvgCents: flags.anomaly?.baselineAvgCents ?? null,
    });

    if (result.length >= limit) break;
  }

  return result;
}
