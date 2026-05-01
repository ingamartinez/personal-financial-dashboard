import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { insertTransferGroup } from "@/lib/transactions/transfer-groups";
import type { DB } from "@/lib/db";
import { db as defaultDb } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import type { Currency, TransactionSource } from "@/lib/types";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "reconciliation/cartera-tc-router" });

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InsertCarteraTcPairOpts {
  userId: number;
  savingsAccountId: number;
  tcAccountId: number;
  /** Absolute amount in cents (positive bigint). */
  amountCents: bigint;
  currency: Currency;
  occurredAt: Date;
  /** Number of monthly installments in the plan (e.g. 60). Must be > 1. */
  installmentsTotal: number;
  /**
   * Rate in percent × 10000 (EM/MV). 1.39% EM → 13900.
   * Non-null required: cartera TC always comes with an explicit rate from the
   * SMS/extract. Null would fall back to the account bucket, which is wrong
   * for cartera (its rate is per-contract, not per-account).
   */
  installmentRateEmX10k: number;
  source: TransactionSource;
  /** External ID for savings leg (dedup key). */
  externalIdSavings?: string | null;
  /** External ID for TC leg (dedup key). */
  externalIdTc?: string | null;
  /** Raw SMS / email body preserved in rawData for audit. */
  originalSmsBody?: string;
  /** Optional override — if provided, used as the transfer group UUID. */
  existingGroupId?: string;
  database?: DB;
}

export type InsertCarteraTcPairResult =
  | { status: "inserted"; transferGroupId: string }
  | { status: "duplicated" }
  | { status: "error"; errorReason: string };

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Insert a "compra de cartera TC" transfer pair (#687).
 *
 * Bancolombia disburses cash to savings (credit, +amount) and the same amount
 * becomes a deferred TC debit (-amount) with a fixed monthly-rate plan.
 * Both legs share channel='transfer' and category_slug=null — the pair is NOT
 * an expense or income event, exactly like pago-tc.
 *
 * The TC leg carries:
 *   - installmentsTotal (e.g. 60)
 *   - installmentRateEmX10k (e.g. 13900 for 1.39% EM)
 *   - rawData.kind = "cartera_tc", rawData.role = "tc_debit"
 *
 * The savings leg carries:
 *   - rawData.kind = "cartera_tc", rawData.role = "savings_disbursement"
 *
 * Mirrors `insertNewPagoTcPair` in pago-tc-router.ts but accepts explicit
 * account IDs (the caller has already resolved which accounts to use) and
 * carries the installment plan fields on the TC leg.
 */
export async function insertNewCarteraTcPair(
  opts: InsertCarteraTcPairOpts,
): Promise<InsertCarteraTcPairResult> {
  const {
    userId,
    savingsAccountId,
    tcAccountId,
    amountCents,
    currency,
    occurredAt,
    installmentsTotal,
    installmentRateEmX10k,
    source,
    externalIdSavings,
    externalIdTc,
    originalSmsBody,
    existingGroupId,
    database = defaultDb,
  } = opts;

  if (amountCents <= BigInt(0)) {
    return {
      status: "error",
      errorReason: `amountCents must be a positive bigint, got ${amountCents}`,
    };
  }

  // Fix #3 (suggestion): cartera TC always has multiple installments — a
  // single-installment plan is a regular purchase, not a cartera plan.
  if (installmentsTotal <= 1) {
    return {
      status: "error",
      errorReason: "installmentsTotal must be > 1 for a cartera TC plan",
    };
  }

  // Fix #1 (CRITICAL): verify both accounts belong to userId and are not
  // archived before passing them to insertTransferGroup. Mirrors the
  // ownership check in pago-tc-router.ts → insertNewPagoTcPair.
  const owned = await database
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        inArray(accounts.id, [savingsAccountId, tcAccountId]),
        eq(accounts.userId, userId),
        notDeleted(accounts.deletedAt),
      ),
    );

  if (owned.length !== 2) {
    log.warn(
      {
        userId,
        savingsAccountId,
        tcAccountId,
        foundCount: owned.length,
        event: "cartera_tc_account_ownership_failed",
      },
      "cartera TC pair: one or both accounts do not belong to user or are archived",
    );
    return {
      status: "error",
      errorReason: "account not found or does not belong to user",
    };
  }

  const transferGroupId = existingGroupId ?? randomUUID();
  // Fix #2 (warning): both ternary branches were identical — collapse to the
  // single string. originalSmsBody is preserved in rawData for audit.
  const descriptionRaw = `Compra de Cartera TC (${installmentsTotal}×)`;

  const insertResult = await insertTransferGroup({
    userId,
    existingGroupId: transferGroupId,
    legs: [
      {
        // Savings leg: Bancolombia credits this amount to the savings account.
        accountId: savingsAccountId,
        amountCents: amountCents, // positive — inbound cash
        currency: "COP", // savings are always COP at Bancolombia
        descriptionRaw,
        source,
        occurredAt,
        externalId: externalIdSavings ?? null,
        rawData: {
          kind: "cartera_tc",
          role: "savings_disbursement",
          ...(originalSmsBody ? { originalSmsBody } : {}),
        },
      },
      {
        // TC leg: same amount becomes a deferred debit on the TC.
        accountId: tcAccountId,
        amountCents: -amountCents, // negative — the TC owes this
        currency,
        descriptionRaw,
        source,
        occurredAt,
        externalId: externalIdTc ?? null,
        installmentsTotal,
        installmentRateEmX10k,
        rawData: {
          kind: "cartera_tc",
          role: "tc_debit",
          installmentsTotal,
          installmentRateEmX10k,
          ...(originalSmsBody ? { originalSmsBody } : {}),
        },
      },
    ],
    database,
  });

  if (insertResult.status === "inserted") {
    log.info(
      {
        userId,
        event: "cartera_tc_pair_inserted",
        savingsAccountId,
        tcAccountId,
        amountCents: amountCents.toString(),
        currency,
        installmentsTotal,
        installmentRateEmX10k,
        transferGroupId: insertResult.transferGroupId,
        txIds: insertResult.txIds,
      },
      "inserted cartera TC transfer pair",
    );
    return { status: "inserted", transferGroupId: insertResult.transferGroupId };
  }

  if (insertResult.status === "duplicated") {
    return { status: "duplicated" };
  }

  return { status: "error", errorReason: insertResult.reason };
}
