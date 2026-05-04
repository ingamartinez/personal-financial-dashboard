import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { db as defaultDb } from "@/lib/db";
import { transactions } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import type { Currency, TransactionSource } from "@/lib/types";

const log = createLogger({ module: "transactions/transfer-groups" });

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

// ---------------------------------------------------------------------------
// Link two existing transactions as a manual transfer pair (#762)
// ---------------------------------------------------------------------------

export type LinkExistingAsTransferResult =
  | { status: "ok"; transferGroupId: string }
  | { status: "conflict"; message: string }
  | { status: "error"; message: string };

/**
 * Links two already-ingested transactions as a transfer pair by assigning them
 * a shared transferGroupId and setting channel="transfer", categorySlug=null.
 *
 * This is the manual-link equivalent of the auto-pairer's applyGroupId. It
 * uses the SAME atomic SELECT FOR UPDATE + idempotency logic so it can be
 * called safely even if one leg is already grouped:
 *   - Both in same group → idempotent success
 *   - Both in DIFFERENT groups → conflict (bail without writes)
 *   - One already grouped → adopt that groupId for the other leg
 *   - Neither grouped → new randomUUID groupId
 *
 * Tenant safety: both txIdA and txIdB MUST belong to userId — the caller
 * (server action) verifies this before calling us, and the SELECT FOR UPDATE
 * inside the transaction double-checks via the userId predicate.
 */
export async function linkExistingTransactionsAsTransfer(opts: {
  userId: number;
  txIdA: number;
  txIdB: number;
  database?: DB;
}): Promise<LinkExistingAsTransferResult> {
  const { userId, txIdA, txIdB, database = defaultDb } = opts;

  try {
    const result = await database.transaction(async (trx) => {
      // Re-read both rows inside the transaction WITH FOR UPDATE so concurrent
      // calls serialize — same pattern as the auto-pairer.
      const rows = await trx
        .select({
          id: transactions.id,
          transferGroupId: transactions.transferGroupId,
        })
        .from(transactions)
        .where(and(eq(transactions.userId, userId), inArray(transactions.id, [txIdA, txIdB])))
        .for("update");

      if (rows.length !== 2) {
        return {
          status: "error" as const,
          message: "Una o ambas transacciones no se encontraron para este usuario.",
        };
      }

      const existingA = rows.find((r) => r.id === txIdA)?.transferGroupId ?? null;
      const existingB = rows.find((r) => r.id === txIdB)?.transferGroupId ?? null;

      // Defense in depth: when adopting an existing groupId, ensure that group
      // has exactly 1 active member (the tx we already know about). If it has
      // more, adopting would create a 3+-member group — an invariant violation.
      // The UI already prevents this by filtering candidates with
      // isNull(transferGroupId), but this guard protects callers that bypass
      // the UI (scripts, tests, future features).
      async function groupMemberCount(groupId: string): Promise<number> {
        const [row] = await trx
          .select({ n: count() })
          .from(transactions)
          .where(
            and(
              eq(transactions.userId, userId),
              eq(transactions.transferGroupId, groupId),
              isNull(transactions.deletedAt),
            ),
          );
        return row?.n ?? 0;
      }

      let groupId: string;
      if (existingA && existingB) {
        if (existingA === existingB) {
          // Already paired to the same group — fully idempotent.
          return { status: "ok" as const, transferGroupId: existingA };
        }
        // Both grouped but to DIFFERENT groups — conflict. Bail without writes.
        log.error(
          {
            txIdA,
            txIdB,
            userId,
            existingGroupA: existingA,
            existingGroupB: existingB,
            event: "manual_link_conflict",
          },
          "both legs already paired to different groups — refusing to merge",
        );
        return {
          status: "conflict" as const,
          message:
            "Una de las transacciones ya pertenece a otro grupo de transferencia. No se puede fusionar.",
        };
      } else if (existingA) {
        // txA is already in a group. Only adopt it if that group has exactly
        // 1 live member (txA itself). If it already has a partner, adding txB
        // would produce a 3-member group — conflict.
        const membersA = await groupMemberCount(existingA);
        if (membersA !== 1) {
          log.error(
            {
              txIdA,
              txIdB,
              userId,
              existingGroupA: existingA,
              membersA,
              event: "manual_link_conflict_3member",
            },
            "txA's group already has a partner — refusing to adopt into 3-member group",
          );
          return {
            status: "conflict" as const,
            message:
              "La transacción A ya está emparejada con otra transacción. No se puede agregar una tercera.",
          };
        }
        groupId = existingA;
      } else if (existingB) {
        // Same guard for the txB path.
        const membersB = await groupMemberCount(existingB);
        if (membersB !== 1) {
          log.error(
            {
              txIdA,
              txIdB,
              userId,
              existingGroupB: existingB,
              membersB,
              event: "manual_link_conflict_3member",
            },
            "txB's group already has a partner — refusing to adopt into 3-member group",
          );
          return {
            status: "conflict" as const,
            message:
              "La transacción B ya está emparejada con otra transacción. No se puede agregar una tercera.",
          };
        }
        groupId = existingB;
      } else {
        groupId = randomUUID();
      }

      // Update only the legs that don't have a group yet.
      for (const txId of [txIdA, txIdB]) {
        await trx
          .update(transactions)
          .set({
            transferGroupId: groupId,
            channel: "transfer",
            categorySlug: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(transactions.id, txId),
              eq(transactions.userId, userId),
              isNull(transactions.transferGroupId),
            ),
          );
      }

      return { status: "ok" as const, transferGroupId: groupId };
    });

    if (result.status === "ok") {
      log.info(
        { txIdA, txIdB, userId, transferGroupId: result.transferGroupId, event: "manual_link_ok" },
        "transactions manually linked as transfer pair",
      );
    }
    return result;
  } catch (err) {
    log.error(
      { err, txIdA, txIdB, userId, event: "manual_link_error" },
      "failed to manually link transactions as transfer",
    );
    return { status: "error", message: "Error interno al linkear las transacciones." };
  }
}
