/**
 * Category anomaly detector — B.4 (Epic I, #719).
 *
 * Fires when a classified tx has category C₂ for a (user, canonical_merchant)
 * pair that has ≥10 prior transactions, of which ≥80% fell under some other
 * category C₁.
 *
 * Skip conditions:
 *   - classificationMethod IN ('manual', 'manual_confirmed') — user chose it
 *   - categorySlug IS NULL — unclassified
 *   - channel = 'transfer'
 *   - recurring_id IS NOT NULL
 *   - canonical_merchant IS NULL
 *
 * On trigger:
 *   - Writes `anomaly_flags.categoryAnomaly` to the tx (merges with existing flags).
 *   - Emits one notification per tx (`type="category_anomaly"`).
 *
 * Pure functions exported for unit tests.
 * `detectCategoryAnomalyForUser` is the DB-driven entry point.
 */

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db as defaultDb } from "@/lib/db";
import { categories, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { emitNotification } from "@/lib/notifications/emit";
import { mergeAnomalyFlags } from "@/lib/insights/merchant-anomaly";
import type { AnomalyFlags } from "@/lib/insights/merchant-anomaly";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "insights/category-anomaly-detector" });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum prior transactions required to check for category anomaly. */
export const CATEGORY_ANOMALY_MIN_HISTORY = 10;

/** Minimum share of prior txs under the modal category to fire. */
export const CATEGORY_ANOMALY_MIN_SHARE = 0.8;

// ---------------------------------------------------------------------------
// Pure types
// ---------------------------------------------------------------------------

export type CategoryHistoryEntry = {
  categorySlug: string;
  count: number;
};

export type CategoryAnomalyResult =
  | { isAnomaly: false }
  | {
      isAnomaly: true;
      expectedCategory: string; // modal category slug
      actualCategory: string;
      modalShare: number;
    };

// ---------------------------------------------------------------------------
// Pure detection function
// ---------------------------------------------------------------------------

/**
 * Given a list of prior category counts for a merchant+user pair, and the
 * current tx's category slug, determine whether a category anomaly has fired.
 *
 * @param history       Prior tx counts by category slug (all combined).
 * @param actualCategory The category assigned to the current tx.
 */
export function evaluateCategoryAnomaly(
  history: CategoryHistoryEntry[],
  actualCategory: string,
): CategoryAnomalyResult {
  const total = history.reduce((sum, h) => sum + h.count, 0);
  if (total < CATEGORY_ANOMALY_MIN_HISTORY) return { isAnomaly: false };

  // Find modal category
  let modalEntry: CategoryHistoryEntry | null = null;
  for (const h of history) {
    if (modalEntry === null || h.count > modalEntry.count) {
      modalEntry = h;
    }
  }

  if (!modalEntry) return { isAnomaly: false };

  const modalShare = modalEntry.count / total;

  if (modalShare < CATEGORY_ANOMALY_MIN_SHARE) return { isAnomaly: false };
  if (modalEntry.categorySlug === actualCategory) return { isAnomaly: false };

  return {
    isAnomaly: true,
    expectedCategory: modalEntry.categorySlug,
    actualCategory,
    modalShare,
  };
}

// ---------------------------------------------------------------------------
// DB-driven entry point
// ---------------------------------------------------------------------------

type DB = typeof defaultDb;

/**
 * Detect category anomalies for a user's newly-classified transaction IDs.
 *
 * For each eligible tx, queries the prior category distribution for the
 * (user, canonical_merchant) pair and fires when the modal category diverges.
 *
 * Called fire-and-forget from classify-tx worker.
 */
export async function detectCategoryAnomalyForUser(
  userId: number,
  classifiedIds: number[],
  database: DB = defaultDb,
): Promise<void> {
  if (classifiedIds.length === 0) return;

  // Fetch classified txs
  const txRows = await database
    .select({
      id: transactions.id,
      canonicalMerchant: transactions.canonicalMerchant,
      categorySlug: transactions.categorySlug,
      classificationMethod: transactions.classificationMethod,
      channel: transactions.channel,
      recurringId: transactions.recurringId,
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

  // Fetch category names for notifications (user's own categories)
  const allCategories = await database
    .select({ slug: categories.slug, name: categories.name })
    .from(categories)
    .where(and(eq(categories.userId, userId), notDeleted(categories.deletedAt)));

  const categoryNameMap = new Map<string, string>();
  for (const cat of allCategories) {
    categoryNameMap.set(cat.slug, cat.name);
  }

  for (const tx of txRows) {
    try {
      // Skip rules
      if (tx.canonicalMerchant === null) continue;
      if (tx.categorySlug === null) continue;
      if (tx.channel === "transfer") continue;
      if (tx.recurringId !== null) continue;
      if (tx.classificationMethod === "manual" || tx.classificationMethod === "manual_confirmed") {
        continue;
      }

      // Query prior category distribution for (user, canonical_merchant),
      // excluding the current tx
      const historyRows = await database
        .select({
          categorySlug: transactions.categorySlug,
          count: sql<string>`COUNT(*)`,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.canonicalMerchant, tx.canonicalMerchant),
            notDeleted(transactions.deletedAt),
            ne(transactions.id, tx.id),
            sql`${transactions.categorySlug} IS NOT NULL`,
            sql`${transactions.channel} <> 'transfer'`,
            sql`${transactions.recurringId} IS NULL`,
          ),
        )
        .groupBy(transactions.categorySlug);

      const history: CategoryHistoryEntry[] = historyRows
        .filter((r) => r.categorySlug !== null)
        .map((r) => ({
          categorySlug: r.categorySlug!,
          count: Number(r.count),
        }));

      const result = evaluateCategoryAnomaly(history, tx.categorySlug);

      if (!result.isAnomaly) continue;

      const now = new Date().toISOString();
      const categoryAnomalyFlag: AnomalyFlags["categoryAnomaly"] = {
        expectedCategory: result.expectedCategory,
        actualCategory: result.actualCategory,
        modalShare: result.modalShare,
      };

      const existing = tx.anomalyFlags as AnomalyFlags | null;
      const next: AnomalyFlags = { categoryAnomaly: categoryAnomalyFlag, detectedAt: now };
      const merged = existing ? mergeAnomalyFlags(existing, next) : next;

      await database
        .update(transactions)
        .set({ anomalyFlags: merged, updatedAt: new Date() })
        .where(and(eq(transactions.id, tx.id), eq(transactions.userId, userId)));

      const expectedName = categoryNameMap.get(result.expectedCategory) ?? result.expectedCategory;
      const actualName = categoryNameMap.get(result.actualCategory) ?? result.actualCategory;

      emitNotification(userId, {
        type: "category_anomaly",
        entityId: `category-anomaly:${tx.id}`,
        title: "Categoría inusual detectada",
        body: `Categoría inusual — usualmente ${expectedName}, hoy ${actualName}`,
        actionUrl: `/transactions?highlight=${tx.id}`,
        priority: "low",
        metadata: {
          txId: tx.id,
          canonicalMerchant: tx.canonicalMerchant,
          expectedCategory: result.expectedCategory,
          actualCategory: result.actualCategory,
          modalShare: result.modalShare,
        },
      }).catch((err: unknown) => {
        log.error(
          { err, userId, txId: tx.id, event: "category_anomaly_emit_failed" },
          "failed to emit category_anomaly notification",
        );
      });

      log.info(
        {
          userId,
          txId: tx.id,
          canonicalMerchant: tx.canonicalMerchant,
          expectedCategory: result.expectedCategory,
          actualCategory: result.actualCategory,
          modalShare: result.modalShare,
          event: "category_anomaly_detected",
        },
        "category anomaly detected",
      );
    } catch (err) {
      log.error(
        { err, userId, txId: tx.id, event: "category_anomaly_tx_failed" },
        "error evaluating category anomaly for tx",
      );
    }
  }
}
