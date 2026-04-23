"use server";

// #434 — batch soft-delete balance_adjustment txs from the reconcile page.
// Complements #433 (which creates plugs) — users end up with stale plugs
// once they import real data that supersedes the manual adjustment. This
// action lets them clear the obsolete ones in bulk.

import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { accounts, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { derivedBalanceCentsSql } from "@/lib/accounts/queries";
import { getSessionUser } from "@/lib/auth/session";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "plug-cleanup-actions" });

const archiveSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  // JSON-encoded array of tx ids. We parse + validate manually so an
  // empty / invalid payload rejects before touching the DB.
  txIds: z.array(z.coerce.number().int().positive()).min(1).max(500),
});

export type ArchivePlugsResult = {
  ok: true;
  archivedCount: number;
  newBalanceCentsStr: string;
};

// Soft-deletes the given balance_adjustment txs IF they belong to the user +
// account AND are currently live. Rows that don't match (wrong user/account,
// wrong source, already deleted, unknown id) are silently skipped — the
// action is idempotent and safe to retry on partial success.
export async function archiveBalanceAdjustmentsAction(
  formData: FormData,
): Promise<ArchivePlugsResult> {
  const session = await getSessionUser();

  const rawAccountId = formData.get("accountId");
  const rawTxIds = formData.get("txIds");
  if (typeof rawTxIds !== "string") {
    throw new Error("tx_ids_missing");
  }
  let parsedIds: unknown;
  try {
    parsedIds = JSON.parse(rawTxIds);
  } catch {
    throw new Error("tx_ids_not_json");
  }
  const input = archiveSchema.parse({
    accountId: rawAccountId,
    txIds: parsedIds,
  });

  // Tenancy guard: verify the account belongs to the user.
  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, session.id),
        eq(accounts.id, input.accountId),
        notDeleted(accounts.deletedAt),
      ),
    )
    .limit(1);
  if (!account) throw new Error("account_not_found");

  const now = new Date();
  const result = await db
    .update(transactions)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(transactions.userId, session.id),
        eq(transactions.accountId, input.accountId),
        eq(transactions.source, "balance_adjustment"),
        inArray(transactions.id, input.txIds),
        notDeleted(transactions.deletedAt),
      ),
    )
    .returning({ id: transactions.id });

  // Recompute the account's derived balance so the caller can confirm-show
  // the post-archive state without another round-trip.
  const [balanceRow] = await db
    .select({ cents: derivedBalanceCentsSql })
    .from(accounts)
    .where(and(eq(accounts.userId, session.id), eq(accounts.id, input.accountId)))
    .limit(1);

  log.info(
    {
      event: "plug_cleanup_batch",
      userId: session.id,
      accountId: input.accountId,
      requestedIds: input.txIds.length,
      archivedCount: result.length,
      newBalanceCents: balanceRow?.cents ?? "0",
    },
    "archived balance_adjustment plugs in batch",
  );

  revalidatePath("/");
  revalidatePath("/transactions");
  revalidatePath(`/settings/accounts/${input.accountId}/reconcile`);
  revalidatePath("/settings/accounts");

  return {
    ok: true,
    archivedCount: result.length,
    newBalanceCentsStr: balanceRow?.cents ?? "0",
  };
}

// Un-archive for auditability — the issue explicitly lists undo as non-goal,
// but callers need a way to recover from a mistaken bulk-archive. Scoped to
// a single tx id to keep the blast radius small.
const restoreSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  txId: z.coerce.number().int().positive(),
});

export async function restoreBalanceAdjustmentAction(
  formData: FormData,
): Promise<{ ok: true; restored: boolean }> {
  const session = await getSessionUser();
  const input = restoreSchema.parse({
    accountId: formData.get("accountId"),
    txId: formData.get("txId"),
  });

  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, session.id),
        eq(accounts.id, input.accountId),
        notDeleted(accounts.deletedAt),
      ),
    )
    .limit(1);
  if (!account) throw new Error("account_not_found");

  const result = await db
    .update(transactions)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(transactions.userId, session.id),
        eq(transactions.accountId, input.accountId),
        eq(transactions.id, input.txId),
        eq(transactions.source, "balance_adjustment"),
        sql`${transactions.deletedAt} IS NOT NULL`,
      ),
    )
    .returning({ id: transactions.id });

  log.info(
    {
      event: "plug_cleanup_restore",
      userId: session.id,
      accountId: input.accountId,
      txId: input.txId,
      restored: result.length > 0,
    },
    "restored (or no-op) balance_adjustment plug",
  );

  revalidatePath("/");
  revalidatePath("/transactions");
  revalidatePath(`/settings/accounts/${input.accountId}/reconcile`);
  revalidatePath("/settings/accounts");

  return { ok: true, restored: result.length > 0 };
}
