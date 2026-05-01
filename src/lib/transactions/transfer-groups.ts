import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { db as defaultDb } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import type { Currency, TransactionSource } from "@/lib/types";

// Single leg of a transfer group — one INSERT into `transactions`. Sign matters:
// a debit is negative, a credit is positive. Category is NEVER carried on a
// transfer leg; channel is always forced to "transfer" by `insertTransferGroup`.
//
// `externalId` is the dedup key shared with the non-transfer path: a second
// ingest attempt of the same SMS hits the unique (account_id, external_id)
// index and rolls the group back (status="duplicated"). Callers that don't
// dedupe (manual UI) pass `null`.
//
// `installmentsTotal` and `installmentRateEmX10k` are optional and only
// meaningful for TC debit legs of a cartera TC pair (#687). Default behavior
// is unchanged when omitted: installmentsTotal defaults to 1 (single payment)
// and installmentRateEmX10k defaults to null (inherit from account bucket).
export type TransferLeg = {
  accountId: number;
  amountCents: bigint;
  currency: Currency;
  descriptionRaw: string;
  descriptionClean?: string | null;
  merchant?: string | null;
  counterpartyId?: number | null;
  source: TransactionSource;
  occurredAt: Date;
  externalId?: string | null;
  rawData?: Record<string, unknown>;
  notes?: string | null;
  /** Number of monthly installments. Only meaningful for cartera TC legs. Defaults to 1. */
  installmentsTotal?: number;
  /** Rate in percent × 10000 (EM/MV). 1.39% EM → 13900. Null = inherit from account bucket. */
  installmentRateEmX10k?: number | null;
};

export type TransferGroupValidationError =
  | "empty"
  | "single-leg"
  | "unbalanced"
  | "missing-opposite-signs"
  | "rate-without-plan";

export type TransferGroupValidationResult =
  | { ok: true }
  | { ok: false; reason: TransferGroupValidationError };

// Pure. Shared by the insert helper, the manual UI action, and tests so the
// invariant definition lives in exactly one place.
export function validateTransferGroupLegs(legs: TransferLeg[]): TransferGroupValidationResult {
  if (legs.length === 0) return { ok: false, reason: "empty" };
  if (legs.length === 1) return { ok: false, reason: "single-leg" };

  let sum = BigInt(0);
  let hasPositive = false;
  let hasNegative = false;
  for (const leg of legs) {
    sum += leg.amountCents;
    if (leg.amountCents > BigInt(0)) hasPositive = true;
    else if (leg.amountCents < BigInt(0)) hasNegative = true;
  }

  if (!hasPositive || !hasNegative) return { ok: false, reason: "missing-opposite-signs" };
  if (sum !== BigInt(0)) return { ok: false, reason: "unbalanced" };

  // A non-null installmentRateEmX10k on a leg with installmentsTotal <= 1 is
  // meaningless — a rate only has meaning when there is a multi-installment
  // plan. Guard here so callers get a clear error instead of silently storing
  // a rate that will never be used.
  for (const leg of legs) {
    if (
      leg.installmentRateEmX10k != null &&
      (leg.installmentsTotal == null || leg.installmentsTotal <= 1)
    ) {
      return { ok: false, reason: "rate-without-plan" };
    }
  }

  return { ok: true };
}

export type InsertTransferGroupResult =
  | { status: "inserted"; transferGroupId: string; txIds: number[] }
  | { status: "duplicated" }
  | { status: "error"; reason: string };

// Inserts every leg atomically with a shared transfer_group_id. `channel` is
// always forced to "transfer" and `categorySlug` to null — transfers are not
// spend or income. Invariants (Σ=0, opposite signs, ≥2 legs) are validated
// before touching the DB.
//
// If any leg conflicts on (account_id, external_id), the transaction rolls
// back and we return "duplicated" — partial groups are never persisted.
export async function insertTransferGroup(opts: {
  userId: number;
  legs: TransferLeg[];
  existingGroupId?: string;
  database?: DB;
}): Promise<InsertTransferGroupResult> {
  const { userId, legs, existingGroupId, database = defaultDb } = opts;

  const validation = validateTransferGroupLegs(legs);
  if (!validation.ok) {
    return { status: "error", reason: `invalid transfer group: ${validation.reason}` };
  }

  const transferGroupId = existingGroupId ?? randomUUID();

  try {
    const txIds = await database.transaction(async (trx) => {
      const inserted: number[] = [];
      for (const leg of legs) {
        const result = await trx
          .insert(transactions)
          .values({
            userId,
            accountId: leg.accountId,
            occurredAt: leg.occurredAt,
            amountCents: leg.amountCents,
            currency: leg.currency,
            descriptionRaw: leg.descriptionRaw,
            descriptionClean: leg.descriptionClean ?? null,
            merchant: leg.merchant ?? null,
            categorySlug: null,
            counterpartyId: leg.counterpartyId ?? null,
            classificationMethod: "manual",
            classificationConfidence: null,
            source: leg.source,
            channel: "transfer",
            transferGroupId,
            externalId: leg.externalId ?? null,
            rawData: leg.rawData ?? {},
            notes: leg.notes ?? null,
            installmentsTotal: leg.installmentsTotal ?? 1,
            installmentRateEmX10k: leg.installmentRateEmX10k ?? null,
          })
          .onConflictDoNothing({
            target: [transactions.accountId, transactions.externalId],
            where: sql`${transactions.externalId} IS NOT NULL`,
          })
          .returning({ id: transactions.id });

        if (result.length === 0) {
          // A duplicate on one leg means the whole group is duplicated
          // — rollback by throwing a sentinel we catch outside.
          throw new TransferGroupDuplicate();
        }
        inserted.push(result[0].id);
      }
      return inserted;
    });

    return { status: "inserted", transferGroupId, txIds };
  } catch (err) {
    if (err instanceof TransferGroupDuplicate) return { status: "duplicated" };
    return { status: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}

class TransferGroupDuplicate extends Error {
  constructor() {
    super("transfer-group-duplicate");
    this.name = "TransferGroupDuplicate";
  }
}

// Soft-deletes every leg of a transfer group atomically. Called by the
// archive action when the tx being archived belongs to a group — keeps the
// Σ=0 invariant intact (archiving half a transfer would make archived totals
// wrong). Pass `transferGroupId = null` to no-op.
//
// Returns the count of newly archived rows (rows already archived are skipped
// via the `deleted_at IS NULL` filter so the call is idempotent).
export async function archiveTransferGroup(opts: {
  userId: number;
  transferGroupId: string;
  database?: DB;
}): Promise<number> {
  const { userId, transferGroupId, database = defaultDb } = opts;
  const result = await database
    .update(transactions)
    .set({ deletedAt: sql`NOW()`, updatedAt: new Date() })
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.transferGroupId, transferGroupId),
        sql`${transactions.deletedAt} IS NULL`,
      ),
    )
    .returning({ id: transactions.id });
  return result.length;
}

// Inverse of `archiveTransferGroup`. Used by the restore path so the user
// can un-archive the whole group, not just the leg they clicked.
export async function restoreTransferGroup(opts: {
  userId: number;
  transferGroupId: string;
  database?: DB;
}): Promise<number> {
  const { userId, transferGroupId, database = defaultDb } = opts;
  const result = await database
    .update(transactions)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.transferGroupId, transferGroupId),
        sql`${transactions.deletedAt} IS NOT NULL`,
      ),
    )
    .returning({ id: transactions.id });
  return result.length;
}

// Fetches the sibling txs that share a transfer_group_id. Used by the
// `/transactions` row renderer to show the counter-leg badge and by the
// archive action to know whether to cascade. Always scoped to `userId`
// per tenancy rules (memory: per-user-table-join-tenant-safety).
export async function listTransferGroupLegs(opts: {
  userId: number;
  transferGroupIds: string[];
  database?: DB;
}): Promise<
  Array<{
    id: number;
    transferGroupId: string;
    accountId: number;
    amountCents: bigint;
    deletedAt: Date | null;
  }>
> {
  const { userId, transferGroupIds, database = defaultDb } = opts;
  if (transferGroupIds.length === 0) return [];
  return database
    .select({
      id: transactions.id,
      transferGroupId: transactions.transferGroupId,
      accountId: transactions.accountId,
      amountCents: transactions.amountCents,
      deletedAt: transactions.deletedAt,
    })
    .from(transactions)
    .where(
      and(eq(transactions.userId, userId), inArray(transactions.transferGroupId, transferGroupIds)),
    ) as Promise<
    Array<{
      id: number;
      transferGroupId: string;
      accountId: number;
      amountCents: bigint;
      deletedAt: Date | null;
    }>
  >;
}
