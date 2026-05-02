/**
 * Merchant anomaly detection — B.1 per-merchant anomaly + B.2 first-encounter.
 * Part of Epic I (#255), issue #713.
 *
 * Two detection signals:
 *   B.1 — Anomaly: current tx amount is ≥ 3× the 30-day rolling average for
 *         (user, canonical_merchant, currency), and abs(delta) ≥ 10 000 COP.
 *         Only fires when the merchant has ≥ 5 prior occurrences in the window.
 *
 *   B.2 — First-encounter: no prior live tx for (user, canonical_merchant)
 *         over the user's full history. Only fires on expenses (amountCents < 0),
 *         non-transfer, non-recurring.
 *
 * Detection order:
 *   1. Apply skip rules (null merchant, transfer, recurring-linked, non-expense).
 *   2. If first-encounter → emit B.2, SKIP B.1 baseline (no history exists).
 *   3. Else if history ≥ 5 in 30-day window → run B.1 baseline.
 *   4. Else (history < 5) → no signal.
 *
 * Pure functions (`evaluateMerchantSignals`) are exported for unit tests.
 * `detectMerchantSignals` is the DB-driven entry point called from the worker.
 */

import { and, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { db as defaultDb } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { emitNotification } from "@/lib/notifications/emit";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "insights/merchant-anomaly" });

// ---------------------------------------------------------------------------
// AnomalyFlags type — stored in transactions.anomaly_flags JSONB
// ---------------------------------------------------------------------------

export type AnomalyFlags = {
  anomaly?: {
    factor: number; // ratio: abs(amountCents) / baselineAvgCents
    deltaCents: string; // BigInt serialized as string (abs difference from avg)
    baselineAvgCents: string; // BigInt serialized as string
  };
  firstEncounter?: boolean;
  // #719 (Epic I B.3): velocity cluster — ≥4 distinct-merchant expenses on the
  // same card within a 30-min window.
  velocity?: {
    clusterSize: number;
    windowMinutes: number;
    firstTxId: number;
    lastTxId: number;
  };
  // #719 (Epic I B.4): category anomaly — tx category diverges from the modal
  // category for (user, canonical_merchant) based on prior history.
  categoryAnomaly?: {
    expectedCategory: string; // modal category slug
    actualCategory: string; // current tx category slug
    modalShare: number; // ratio 0..1
  };
  // #719 (Epic I C.4): duplicate payment — same merchant on different accounts
  // within 35 days with similar amounts. Written on the NEW tx only.
  duplicatePayment?: {
    pairedTxId: number;
    otherAccountId: number;
  };
  detectedAt: string; // ISO timestamp
};

// ---------------------------------------------------------------------------
// Merge helper — combines two AnomalyFlags objects without overwriting keys
// ---------------------------------------------------------------------------

/**
 * Merge `next` into `prev` without overwriting any keys already present in
 * `prev`. Both `detectedAt` fields are preserved — `prev.detectedAt` wins.
 *
 * Usage: always merge when updating anomaly_flags on an existing row so that,
 * e.g., a `firstEncounter:true` flag set by B.2 is not lost when B.4 adds
 * `categoryAnomaly` to the same tx.
 */
export function mergeAnomalyFlags(prev: AnomalyFlags, next: Partial<AnomalyFlags>): AnomalyFlags {
  return {
    ...next,
    ...prev, // prev wins on every common key
  };
}

// ---------------------------------------------------------------------------
// Pure detection thresholds (exported for unit test access)
// ---------------------------------------------------------------------------

/** Minimum ratio of amount to baseline avg to trigger anomaly (B.1). */
export const ANOMALY_FACTOR_THRESHOLD = BigInt(3);

/** Minimum absolute delta to avoid noise on micro-purchases (B.1). */
export const ANOMALY_MIN_DELTA_CENTS = BigInt(10_000);

/** Minimum number of prior occurrences in the 30-day window for B.1 to fire. */
export const ANOMALY_MIN_HISTORY = 5;

// ---------------------------------------------------------------------------
// Pure helper types
// ---------------------------------------------------------------------------

export type MerchantHistorySnapshot = {
  /** All prior amounts (absolute value, positive) for the merchant+currency bucket. */
  amounts: bigint[];
};

export type AnomalyCheckResult =
  | { isAnomaly: false }
  | {
      isAnomaly: true;
      factor: number;
      deltaCents: bigint;
      baselineAvgCents: bigint;
    };

export type MerchantSignalResult =
  | { signal: "none" }
  | { signal: "anomaly"; factor: number; deltaCents: bigint; baselineAvgCents: bigint }
  | { signal: "first_encounter" };

// ---------------------------------------------------------------------------
// Pure functions (no DB, no side-effects — fully unit-testable)
// ---------------------------------------------------------------------------

/**
 * Compute rolling average of amounts and check if `txAmountAbs` is anomalous.
 *
 * @param txAmountAbs  Absolute value of the current tx amount (positive bigint).
 * @param history      Prior amounts in the 30-day window (absolute, positive).
 */
export function detectMerchantAnomaly(
  txAmountAbs: bigint,
  history: MerchantHistorySnapshot,
): AnomalyCheckResult {
  const { amounts } = history;
  if (amounts.length < ANOMALY_MIN_HISTORY) return { isAnomaly: false };

  // Compute rolling average
  const sum = amounts.reduce((acc, a) => acc + a, BigInt(0));
  const avg = sum / BigInt(amounts.length);

  if (avg === BigInt(0)) return { isAnomaly: false };

  // Check threshold: txAmountAbs >= 3 × avg AND delta >= 10_000
  const meetsFactorThreshold = txAmountAbs >= ANOMALY_FACTOR_THRESHOLD * avg;
  const delta = txAmountAbs - avg;
  const meetsDeltaThreshold = delta >= ANOMALY_MIN_DELTA_CENTS;

  if (!meetsFactorThreshold || !meetsDeltaThreshold) return { isAnomaly: false };

  // factor stored as float for display (ratio is invariant, safe)
  const factor = Number(txAmountAbs) / Number(avg);

  return {
    isAnomaly: true,
    factor,
    deltaCents: delta,
    baselineAvgCents: avg,
  };
}

/**
 * Pure first-encounter check: returns true when historyCount is exactly 0
 * (no prior live tx for this merchant over the user's full history).
 */
export function detectFirstEncounter(historyCount: number): boolean {
  return historyCount === 0;
}

/**
 * Evaluate merchant signals for a single transaction.
 *
 * Skip rules (must be applied BEFORE calling this):
 *   - canonicalMerchant IS NULL → callers should short-circuit before reaching here.
 *   - channel = 'transfer' → callers must not pass transfer txs.
 *   - recurringId IS NOT NULL → callers must not pass recurring-linked txs.
 *   - amountCents >= 0 (non-expense) → callers must not pass non-expenses.
 *
 * @param txAmountAbs    Absolute value of tx amount_cents (negative tx → pass -amountCents).
 * @param currency       Tx currency (for baseline bucket grouping).
 * @param fullHistoryCount  Count of ALL prior live txs for (userId, canonicalMerchant),
 *                       regardless of currency or window. Used for first-encounter check.
 * @param windowHistory  Prior amounts in the 30-day window for the SAME currency bucket.
 *                       Must already be filtered to (userId, canonicalMerchant, currency).
 */
export function evaluateMerchantSignals(
  txAmountAbs: bigint,
  fullHistoryCount: number,
  windowHistory: MerchantHistorySnapshot,
): MerchantSignalResult {
  // B.2 check first — if first-encounter, skip anomaly (no baseline exists)
  if (detectFirstEncounter(fullHistoryCount)) {
    return { signal: "first_encounter" };
  }

  // B.1 anomaly check — only if window has enough history
  const anomalyResult = detectMerchantAnomaly(txAmountAbs, windowHistory);
  if (anomalyResult.isAnomaly) {
    return {
      signal: "anomaly",
      factor: anomalyResult.factor,
      deltaCents: anomalyResult.deltaCents,
      baselineAvgCents: anomalyResult.baselineAvgCents,
    };
  }

  return { signal: "none" };
}

// ---------------------------------------------------------------------------
// DB-driven entry point — called fire-and-forget from classify-tx worker
// ---------------------------------------------------------------------------

/** Drizzle DB type alias (accepts the real db or a test-injected instance). */
type DB = typeof defaultDb;

/**
 * Query the 30-day window history for a merchant+currency bucket.
 * Returns absolute amounts (positive bigints).
 * Excludes the current tx by id.
 */
async function fetchWindowHistory(
  userId: number,
  canonicalMerchant: string,
  currency: string,
  currentTxId: number,
  database: DB,
): Promise<bigint[]> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const rows = await database
    .select({
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.canonicalMerchant, canonicalMerchant),
        eq(transactions.currency, currency as "COP" | "USD"),
        lt(transactions.amountCents, sql`0`), // expenses only
        notDeleted(transactions.deletedAt),
        gte(transactions.occurredAt, cutoff),
        ne(transactions.id, currentTxId),
      ),
    );

  return rows.map((r) => (r.amountCents < BigInt(0) ? -r.amountCents : r.amountCents));
}

/**
 * Query the total count of prior live txs for (userId, canonicalMerchant) — full history.
 * Excludes the current tx by id.
 */
async function fetchFullHistoryCount(
  userId: number,
  canonicalMerchant: string,
  currentTxId: number,
  database: DB,
): Promise<number> {
  const [row] = await database
    .select({
      count: sql<string>`COUNT(*)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.canonicalMerchant, canonicalMerchant),
        notDeleted(transactions.deletedAt),
        ne(transactions.id, currentTxId),
      ),
    );

  return row ? Number(row.count) : 0;
}

/**
 * DB-driven orchestrator: evaluate merchant signals for a list of newly
 * classified transaction IDs and emit notifications + write anomaly_flags.
 *
 * Called fire-and-forget from the classify-tx worker after classification.
 *
 * @param userId          Owner of the transactions.
 * @param classifiedIds   IDs of transactions that were just classified.
 * @param database        Injected DB instance (default: production db).
 */
export async function detectMerchantSignals(
  userId: number,
  classifiedIds: number[],
  database: DB = defaultDb,
): Promise<void> {
  if (classifiedIds.length === 0) return;

  // Fetch the full transaction rows for the classified IDs
  const txRows = await database
    .select({
      id: transactions.id,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      canonicalMerchant: transactions.canonicalMerchant,
      channel: transactions.channel,
      recurringId: transactions.recurringId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        notDeleted(transactions.deletedAt),
        inArray(transactions.id, classifiedIds),
      ),
    );

  for (const tx of txRows) {
    try {
      // Skip rules — short-circuit before any further DB reads
      if (tx.canonicalMerchant === null) continue;
      if (tx.channel === "transfer") continue;
      if (tx.recurringId !== null) continue;
      if (tx.amountCents >= BigInt(0)) continue; // expenses only (negative amount_cents)

      const txAmountAbs = -tx.amountCents; // always positive

      // Fetch full history count (for B.2 first-encounter)
      const fullHistoryCount = await fetchFullHistoryCount(
        userId,
        tx.canonicalMerchant,
        tx.id,
        database,
      );

      // Fetch 30-day window history for the same currency (for B.1 anomaly)
      const windowAmounts = await fetchWindowHistory(
        userId,
        tx.canonicalMerchant,
        tx.currency,
        tx.id,
        database,
      );

      const result = evaluateMerchantSignals(txAmountAbs, fullHistoryCount, {
        amounts: windowAmounts,
      });

      if (result.signal === "none") continue;

      const now = new Date().toISOString();

      if (result.signal === "first_encounter") {
        const flags: AnomalyFlags = {
          firstEncounter: true,
          detectedAt: now,
        };

        await database
          .update(transactions)
          .set({ anomalyFlags: flags, updatedAt: new Date() })
          .where(and(eq(transactions.id, tx.id), eq(transactions.userId, userId)));

        emitNotification(userId, {
          type: "merchant_first_encounter",
          entityId: `first-merchant:${userId}:${tx.canonicalMerchant}`,
          title: "Nuevo comercio detectado",
          body: `Primera transacción con ${tx.canonicalMerchant}. Confirmá que la categoría es correcta.`,
          actionUrl: "/transactions",
          priority: "low",
          metadata: {
            txId: tx.id,
            canonicalMerchant: tx.canonicalMerchant,
            amountCents: String(tx.amountCents),
            currency: tx.currency,
          },
        }).catch((err: unknown) => {
          log.error(
            { err, userId, txId: tx.id, event: "merchant_first_encounter_emit_failed" },
            "failed to emit merchant_first_encounter notification",
          );
        });

        log.info(
          {
            userId,
            txId: tx.id,
            canonicalMerchant: tx.canonicalMerchant,
            event: "merchant_first_encounter_detected",
          },
          "first-encounter merchant detected",
        );
        continue;
      }

      if (result.signal === "anomaly") {
        const flags: AnomalyFlags = {
          anomaly: {
            factor: result.factor,
            deltaCents: String(result.deltaCents),
            baselineAvgCents: String(result.baselineAvgCents),
          },
          detectedAt: now,
        };

        await database
          .update(transactions)
          .set({ anomalyFlags: flags, updatedAt: new Date() })
          .where(and(eq(transactions.id, tx.id), eq(transactions.userId, userId)));

        emitNotification(userId, {
          type: "merchant_anomaly",
          entityId: `anomaly:${tx.id}`,
          title: "Gasto inusual detectado",
          body: `El gasto en ${tx.canonicalMerchant} es ${result.factor.toFixed(1)}× mayor al promedio habitual.`,
          actionUrl: `/transactions?highlight=${tx.id}`,
          priority: "medium",
          metadata: {
            txId: tx.id,
            canonicalMerchant: tx.canonicalMerchant,
            factor: result.factor,
            deltaCents: String(result.deltaCents),
            baselineAvgCents: String(result.baselineAvgCents),
            currency: tx.currency,
          },
        }).catch((err: unknown) => {
          log.error(
            { err, userId, txId: tx.id, event: "merchant_anomaly_emit_failed" },
            "failed to emit merchant_anomaly notification",
          );
        });

        log.info(
          {
            userId,
            txId: tx.id,
            canonicalMerchant: tx.canonicalMerchant,
            factor: result.factor,
            event: "merchant_anomaly_detected",
          },
          "merchant anomaly detected",
        );
      }
    } catch (err) {
      log.error(
        { err, userId, txId: tx.id, event: "merchant_signal_tx_failed" },
        "error evaluating merchant signals for tx",
      );
      // Continue to next tx — one failure should not block the rest
    }
  }
}
