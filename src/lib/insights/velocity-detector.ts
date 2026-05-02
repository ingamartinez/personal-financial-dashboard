/**
 * Velocity detector — B.3 (Epic I, #719).
 *
 * Fires when ≥4 expense transactions with DISTINCT canonical_merchant values
 * occur on the same physical card (physical_card_id) within any 30-minute
 * window. Rappi multi-order protection: consecutive purchases from the SAME
 * canonical_merchant inside the cluster are NOT counted as distinct.
 *
 * Skip conditions per tx (applied before cluster formation):
 *   - channel = 'transfer'
 *   - recurring_id IS NOT NULL
 *   - amount_cents >= 0 (non-expense)
 *   - canonical_merchant IS NULL
 *
 * Cluster grouping key:
 *   - `physical_card_id` when it is NOT NULL on the account.
 *   - `account_id` as fallback when physical_card_id IS NULL.
 *
 * Cluster size: count of DISTINCT canonical_merchant values (not raw tx count).
 *
 * On trigger: writes `anomaly_flags.velocity` to ALL txs in the cluster
 * (single UPDATE IN), emits ONE notification per cluster.
 *
 * Pure functions are exported for unit tests.
 * `detectVelocityForUser` is the DB-driven entry point.
 */

import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db as defaultDb } from "@/lib/db";
import { accounts, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { emitNotification } from "@/lib/notifications/emit";
import { mergeAnomalyFlags } from "@/lib/insights/merchant-anomaly";
import type { AnomalyFlags } from "@/lib/insights/merchant-anomaly";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "insights/velocity-detector" });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum distinct-merchant count to trigger a velocity alert. */
export const VELOCITY_MIN_CLUSTER_SIZE = 4;

/** Window in minutes for velocity clustering. */
export const VELOCITY_WINDOW_MINUTES = 30;

// ---------------------------------------------------------------------------
// Pure types
// ---------------------------------------------------------------------------

export type VelocityTx = {
  id: number;
  occurredAt: Date;
  amountCents: bigint;
  canonicalMerchant: string; // already filtered — non-null
  cardKey: string; // physical_card_id or account_id (as string)
};

export type VelocityCluster = {
  txIds: number[];
  cardKey: string;
  clusterSize: number;
  firstTxId: number;
  lastTxId: number;
  windowMinutes: number;
  earliestOccurredAt: Date;
};

// ---------------------------------------------------------------------------
// Pure helper — build clusters from a flat list of eligible txs
// ---------------------------------------------------------------------------

/**
 * Group `txs` by `cardKey`, then sweep each group with a 30-minute sliding
 * window to identify clusters of ≥4 DISTINCT canonical merchants.
 *
 * Returns only clusters that meet or exceed VELOCITY_MIN_CLUSTER_SIZE.
 */
export function buildVelocityClusters(txs: VelocityTx[]): VelocityCluster[] {
  // Group by card key
  const byCard = new Map<string, VelocityTx[]>();
  for (const tx of txs) {
    const group = byCard.get(tx.cardKey);
    if (group) {
      group.push(tx);
    } else {
      byCard.set(tx.cardKey, [tx]);
    }
  }

  const clusters: VelocityCluster[] = [];
  const windowMs = VELOCITY_WINDOW_MINUTES * 60 * 1000;

  for (const [cardKey, group] of byCard) {
    // Sort ascending by time
    const sorted = [...group].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

    // Sliding window: expand right, shrink left when window exceeds 30 min
    let left = 0;
    const merchants = new Set<string>();
    // Track merchant→txIds map to collect all txIds in the window
    const windowTxIds = new Set<number>();

    for (let right = 0; right < sorted.length; right++) {
      const current = sorted[right]!;
      merchants.add(current.canonicalMerchant);
      windowTxIds.add(current.id);

      // Shrink left until window fits in VELOCITY_WINDOW_MINUTES
      while (current.occurredAt.getTime() - sorted[left]!.occurredAt.getTime() > windowMs) {
        const leftTx = sorted[left]!;
        windowTxIds.delete(leftTx.id);
        // Re-compute merchants for the remaining window
        merchants.clear();
        left++;
        for (let k = left; k <= right; k++) {
          merchants.add(sorted[k]!.canonicalMerchant);
          windowTxIds.add(sorted[k]!.id);
        }
        // Rebuild windowTxIds from scratch since we might have added leftTx to
        // windowTxIds from a previous loop iteration — cleaner to recompute.
        windowTxIds.clear();
        for (let k = left; k <= right; k++) {
          windowTxIds.add(sorted[k]!.id);
        }
      }

      if (merchants.size >= VELOCITY_MIN_CLUSTER_SIZE) {
        // Collect all txs in window left..right
        const clusterTxIds = Array.from(windowTxIds);
        const windowTxArray = sorted.slice(left, right + 1);
        const firstTx = windowTxArray[0]!;
        const lastTx = windowTxArray[windowTxArray.length - 1]!;
        const actualWindowMs = lastTx.occurredAt.getTime() - firstTx.occurredAt.getTime();
        const actualWindowMinutes = Math.ceil(actualWindowMs / 60_000) || 1;

        clusters.push({
          txIds: clusterTxIds,
          cardKey,
          clusterSize: merchants.size,
          firstTxId: firstTx.id,
          lastTxId: lastTx.id,
          windowMinutes: actualWindowMinutes,
          earliestOccurredAt: firstTx.occurredAt,
        });

        // Advance left past the current position to avoid overlapping clusters
        // for the same card. One cluster per card per window is enough.
        left = right + 1;
        merchants.clear();
        windowTxIds.clear();
      }
    }
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// DB-driven entry point
// ---------------------------------------------------------------------------

type DB = typeof defaultDb;

/**
 * Detect velocity clusters for a user's newly-classified transaction IDs.
 *
 * Fetches the 30-min window of surrounding eligible txs, builds clusters,
 * writes anomaly_flags.velocity to all txs in each cluster, and emits one
 * notification per cluster.
 *
 * Called fire-and-forget from classify-tx worker.
 */
export async function detectVelocityForUser(
  userId: number,
  classifiedIds: number[],
  database: DB = defaultDb,
): Promise<void> {
  if (classifiedIds.length === 0) return;

  // Fetch the classified txs first to determine the time range we need
  const classifiedRows = await database
    .select({
      id: transactions.id,
      occurredAt: transactions.occurredAt,
      amountCents: transactions.amountCents,
      canonicalMerchant: transactions.canonicalMerchant,
      channel: transactions.channel,
      recurringId: transactions.recurringId,
      accountId: transactions.accountId,
      anomalyFlags: transactions.anomalyFlags,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        notDeleted(transactions.deletedAt),
        inArray(transactions.id, classifiedIds),
      ),
    );

  // Filter to eligible txs only
  const eligible = classifiedRows.filter(
    (tx) =>
      tx.amountCents < BigInt(0) &&
      tx.channel !== "transfer" &&
      tx.recurringId === null &&
      tx.canonicalMerchant !== null,
  );

  if (eligible.length === 0) return;

  // Determine the time window to search for surrounding txs
  const earliestMs = Math.min(...eligible.map((tx) => tx.occurredAt.getTime()));
  const latestMs = Math.max(...eligible.map((tx) => tx.occurredAt.getTime()));
  const windowMs = VELOCITY_WINDOW_MINUTES * 60 * 1000;
  const searchStart = new Date(earliestMs - windowMs);
  const searchEnd = new Date(latestMs + windowMs);

  // Fetch account physical_card_id for all involved accounts
  const accountIds = [...new Set(eligible.map((tx) => tx.accountId))];
  const accountRows = await database
    .select({
      id: accounts.id,
      physicalCardId: accounts.physicalCardId,
      name: accounts.name,
      currency: accounts.currency,
      metadata: accounts.metadata,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        notDeleted(accounts.deletedAt),
        inArray(accounts.id, accountIds),
      ),
    );

  const accountPhysicalCardMap = new Map<number, string | null>();
  const accountInfoMap = new Map<
    number,
    { name: string; currency: string; metadata: { last4s?: string[] | null } | null }
  >();
  for (const a of accountRows) {
    accountPhysicalCardMap.set(a.id, a.physicalCardId ?? null);
    accountInfoMap.set(a.id, { name: a.name, currency: a.currency, metadata: a.metadata });
  }

  // Fetch all eligible txs in the surrounding window (not just classified ones)
  const surroundingRows = await database
    .select({
      id: transactions.id,
      occurredAt: transactions.occurredAt,
      amountCents: transactions.amountCents,
      canonicalMerchant: transactions.canonicalMerchant,
      channel: transactions.channel,
      recurringId: transactions.recurringId,
      accountId: transactions.accountId,
      anomalyFlags: transactions.anomalyFlags,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        notDeleted(transactions.deletedAt),
        gte(transactions.occurredAt, searchStart),
        inArray(transactions.accountId, accountIds),
        sql`${transactions.amountCents} < 0`,
        sql`${transactions.channel} <> 'transfer'`,
        sql`${transactions.recurringId} IS NULL`,
        sql`${transactions.canonicalMerchant} IS NOT NULL`,
      ),
    );

  // Build VelocityTx list
  const velocityTxs: VelocityTx[] = surroundingRows
    .filter((tx) => tx.occurredAt <= searchEnd)
    .map((tx) => {
      const physicalCardId = accountPhysicalCardMap.get(tx.accountId);
      const cardKey =
        physicalCardId !== null && physicalCardId !== undefined
          ? physicalCardId
          : String(tx.accountId);
      return {
        id: tx.id,
        occurredAt: tx.occurredAt,
        amountCents: tx.amountCents,
        canonicalMerchant: tx.canonicalMerchant!,
        cardKey,
      };
    });

  const clusters = buildVelocityClusters(velocityTxs);

  // Only process clusters that contain at least one newly-classified tx
  const classifiedIdSet = new Set(classifiedIds);

  for (const cluster of clusters) {
    const hasNewTx = cluster.txIds.some((id) => classifiedIdSet.has(id));
    if (!hasNewTx) continue;

    try {
      const now = new Date().toISOString();
      const velocityFlag: AnomalyFlags["velocity"] = {
        clusterSize: cluster.clusterSize,
        windowMinutes: cluster.windowMinutes,
        firstTxId: cluster.firstTxId,
        lastTxId: cluster.lastTxId,
      };

      // Fetch current anomaly_flags for all txs in cluster to merge
      const clusterRows = await database
        .select({ id: transactions.id, anomalyFlags: transactions.anomalyFlags })
        .from(transactions)
        .where(and(eq(transactions.userId, userId), inArray(transactions.id, cluster.txIds)));

      // Build per-tx merged flags and update each one
      for (const row of clusterRows) {
        const existing = row.anomalyFlags as AnomalyFlags | null;
        const next: AnomalyFlags = { velocity: velocityFlag, detectedAt: now };
        const merged = existing ? mergeAnomalyFlags(existing, next) : next;

        await database
          .update(transactions)
          .set({ anomalyFlags: merged, updatedAt: new Date() })
          .where(and(eq(transactions.id, row.id), eq(transactions.userId, userId)));
      }

      // Determine card label for notification body
      const firstEligible = surroundingRows.find((r) => r.id === cluster.firstTxId);
      let cardLabel = cluster.cardKey;
      if (firstEligible) {
        const accInfo = accountInfoMap.get(firstEligible.accountId);
        if (accInfo) {
          const last4 = accInfo.metadata?.last4s?.[0];
          cardLabel = last4 ? `*${last4}` : accInfo.name;
        }
      }

      const entityId = `velocity:${userId}:${cluster.cardKey}:${cluster.firstTxId}`;

      emitNotification(userId, {
        type: "velocity_cluster",
        entityId,
        title: "Posible uso fraudulento de tarjeta",
        body: `${cluster.clusterSize} compras en ${cluster.windowMinutes} min con TC ${cardLabel} — ¿fuiste vos?`,
        actionUrl: "/transactions",
        priority: "high",
        metadata: {
          clusterSize: cluster.clusterSize,
          windowMinutes: cluster.windowMinutes,
          firstTxId: cluster.firstTxId,
          lastTxId: cluster.lastTxId,
          cardKey: cluster.cardKey,
        },
      }).catch((err: unknown) => {
        log.error(
          { err, userId, entityId, event: "velocity_cluster_emit_failed" },
          "failed to emit velocity_cluster notification",
        );
      });

      log.info(
        {
          userId,
          clusterSize: cluster.clusterSize,
          windowMinutes: cluster.windowMinutes,
          firstTxId: cluster.firstTxId,
          lastTxId: cluster.lastTxId,
          cardKey: cluster.cardKey,
          event: "velocity_cluster_detected",
        },
        "velocity cluster detected",
      );
    } catch (err) {
      log.error(
        { err, userId, cluster, event: "velocity_cluster_tx_failed" },
        "error processing velocity cluster",
      );
    }
  }
}
