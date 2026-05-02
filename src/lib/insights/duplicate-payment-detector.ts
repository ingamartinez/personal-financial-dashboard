/**
 * Duplicate payment detector — C.4 (Epic I, #719).
 *
 * Fires when a newly-classified tx matches an existing tx from the prior 35
 * days under these conditions:
 *   - Same canonical_merchant
 *   - DIFFERENT account_id
 *   - Both are expenses (amount_cents < 0)
 *   - Amount within 5% tolerance (BigInt-only math, no float drift)
 *   - At least ONE of the two has recurring_id IS NOT NULL
 *     (filters out one-off near-duplicate noise)
 *
 * Amount tolerance formula (pure BigInt):
 *   absDiff * 20 <= max(|a|, |b|) — equivalent to absDiff / max <= 5%
 *   (multiply both sides by 20 to stay in integer domain)
 *
 * FX: caller fetches the rate ONCE and passes it in. toCop converts USD to
 * COP before comparison so cross-currency amounts compare correctly.
 *
 * On trigger:
 *   - Writes `anomaly_flags.duplicatePayment` on the NEW tx (not the old one).
 *   - Emits one notification per pair (`type="duplicate_payment"`).
 *
 * Pure functions exported for unit tests.
 * `detectDuplicatePaymentForUser` is the DB-driven entry point.
 */

import { and, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { db as defaultDb } from "@/lib/db";
import { accounts, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { emitNotification } from "@/lib/notifications/emit";
import { mergeAnomalyFlags } from "@/lib/insights/merchant-anomaly";
import type { AnomalyFlags } from "@/lib/insights/merchant-anomaly";
import { toCop } from "@/lib/money";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { formatAccountLabel } from "@/lib/accounts/format";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "insights/duplicate-payment-detector" });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of days to look back when searching for duplicate payments. */
export const DUPLICATE_PAYMENT_WINDOW_DAYS = 35;

// ---------------------------------------------------------------------------
// Pure types
// ---------------------------------------------------------------------------

export type DuplicateCandidatePair = {
  newTxId: number;
  existingTxId: number;
  canonicalMerchant: string;
  newAmountCop: bigint;
  existingAmountCop: bigint;
};

// ---------------------------------------------------------------------------
// Pure amount tolerance check
// ---------------------------------------------------------------------------

/**
 * Returns true when `|a - b| * 20 <= max(|a|, |b|)`.
 * This is equivalent to `|a - b| / max(|a|, |b|) <= 5%` without any floats.
 *
 * Both inputs MUST be positive (caller passes abs values).
 */
export function withinFivePercent(a: bigint, b: bigint): boolean {
  if (a <= BigInt(0) || b <= BigInt(0)) return false;
  const diff = a > b ? a - b : b - a;
  const larger = a > b ? a : b;
  return diff * BigInt(20) <= larger;
}

// ---------------------------------------------------------------------------
// DB-driven entry point
// ---------------------------------------------------------------------------

type DB = typeof defaultDb;

/**
 * Detect duplicate payments for a user's newly-classified transaction IDs.
 *
 * Fetches FX rate ONCE, then for each eligible new tx, checks the prior
 * 35 days for existing txs on a different account with the same merchant and
 * within 5% COP-equivalent amount.
 *
 * Called fire-and-forget from classify-tx worker.
 */
export async function detectDuplicatePaymentForUser(
  userId: number,
  classifiedIds: number[],
  database: DB = defaultDb,
): Promise<void> {
  if (classifiedIds.length === 0) return;

  // Fetch FX rate ONCE for the whole run
  const fx = await getCurrentFxRate(database);
  const fxRate = fx.rate;

  // Fetch the newly-classified txs
  const newTxRows = await database
    .select({
      id: transactions.id,
      canonicalMerchant: transactions.canonicalMerchant,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      accountId: transactions.accountId,
      recurringId: transactions.recurringId,
      channel: transactions.channel,
      occurredAt: transactions.occurredAt,
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

  // Filter: only expenses, non-transfer, non-null merchant
  const eligibleNew = newTxRows.filter(
    (tx) =>
      tx.amountCents < BigInt(0) && tx.channel !== "transfer" && tx.canonicalMerchant !== null,
  );

  if (eligibleNew.length === 0) return;

  // Fetch account info for formatting notification bodies
  const accountIds = [...new Set(eligibleNew.map((tx) => tx.accountId))];
  const accountRows = await database
    .select({
      id: accounts.id,
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

  const accountMap = new Map(accountRows.map((a) => [a.id, a]));

  for (const newTx of eligibleNew) {
    try {
      const cutoff = new Date(
        newTx.occurredAt.getTime() - DUPLICATE_PAYMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      );

      // Look for existing txs in the prior 35 days:
      //   - same canonical_merchant
      //   - different account_id
      //   - expense (amount < 0)
      //   - non-transfer
      //   - has recurring_id (at least one in the pair)
      const existingRows = await database
        .select({
          id: transactions.id,
          amountCents: transactions.amountCents,
          currency: transactions.currency,
          accountId: transactions.accountId,
          recurringId: transactions.recurringId,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            eq(transactions.canonicalMerchant, newTx.canonicalMerchant!),
            ne(transactions.accountId, newTx.accountId),
            ne(transactions.id, newTx.id),
            lt(transactions.amountCents, sql`0`),
            notDeleted(transactions.deletedAt),
            gte(transactions.occurredAt, cutoff),
            sql`${transactions.channel} <> 'transfer'`,
          ),
        )
        .limit(20); // cap to avoid runaway on high-frequency merchants

      // At least ONE of the pair must have recurring_id set
      const newHasRecurring = newTx.recurringId !== null;

      const newAmountCop = toCop(-newTx.amountCents, newTx.currency, fxRate);

      let matched: (typeof existingRows)[number] | null = null;
      for (const existing of existingRows) {
        const pairHasRecurring = newHasRecurring || existing.recurringId !== null;
        if (!pairHasRecurring) continue;

        const existingAmountCop = toCop(-existing.amountCents, existing.currency, fxRate);
        if (!withinFivePercent(newAmountCop, existingAmountCop)) continue;

        matched = existing;
        break;
      }

      if (!matched) continue;

      const now = new Date().toISOString();
      const occurredMonth = newTx.occurredAt.toISOString().slice(0, 7); // YYYY-MM

      // Only write duplicatePayment to new tx anomaly_flags (not the existing one)
      const existingFlags = newTx.anomalyFlags as AnomalyFlags | null;
      const nextFlags: AnomalyFlags = {
        detectedAt: now,
        duplicatePayment: {
          pairedTxId: matched.id,
          otherAccountId: matched.accountId,
        },
      };
      const merged = existingFlags ? mergeAnomalyFlags(existingFlags, nextFlags) : nextFlags;

      await database
        .update(transactions)
        .set({ anomalyFlags: merged, updatedAt: new Date() })
        .where(and(eq(transactions.id, newTx.id), eq(transactions.userId, userId)));

      // Fetch account info for the matched tx if not already loaded
      let matchedAccount = accountMap.get(matched.accountId);
      if (!matchedAccount) {
        const [fetchedAccount] = await database
          .select({
            id: accounts.id,
            name: accounts.name,
            currency: accounts.currency,
            metadata: accounts.metadata,
          })
          .from(accounts)
          .where(
            and(
              eq(accounts.id, matched.accountId),
              eq(accounts.userId, userId),
              notDeleted(accounts.deletedAt),
            ),
          )
          .limit(1);
        if (fetchedAccount) {
          matchedAccount = fetchedAccount;
        }
      }

      const newAccount = accountMap.get(newTx.accountId);
      const accountALabel = newAccount
        ? formatAccountLabel(newAccount)
        : `cuenta ${newTx.accountId}`;
      const accountBLabel = matchedAccount
        ? formatAccountLabel(matchedAccount)
        : `cuenta ${matched.accountId}`;

      const entityId = `dup-payment:${userId}:${newTx.canonicalMerchant}:${occurredMonth}`;

      emitNotification(userId, {
        type: "duplicate_payment",
        entityId,
        title: "Posible pago duplicado",
        body: `Posible pago duplicado: ${newTx.canonicalMerchant} en ${accountALabel} y ${accountBLabel}`,
        actionUrl: `/transactions?highlight=${newTx.id}`,
        priority: "medium",
        metadata: {
          newTxId: newTx.id,
          pairedTxId: matched.id,
          canonicalMerchant: newTx.canonicalMerchant,
          newAccountId: newTx.accountId,
          otherAccountId: matched.accountId,
        },
      }).catch((err: unknown) => {
        log.error(
          { err, userId, txId: newTx.id, event: "duplicate_payment_emit_failed" },
          "failed to emit duplicate_payment notification",
        );
      });

      log.info(
        {
          userId,
          newTxId: newTx.id,
          pairedTxId: matched.id,
          canonicalMerchant: newTx.canonicalMerchant,
          event: "duplicate_payment_detected",
        },
        "duplicate payment detected",
      );
    } catch (err) {
      log.error(
        { err, userId, txId: newTx.id, event: "duplicate_payment_tx_failed" },
        "error evaluating duplicate payment for tx",
      );
    }
  }
}
