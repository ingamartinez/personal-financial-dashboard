"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { accounts, skippedConsolidationCycles } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "skip-cycle-actions" });

const skipSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  cycle: z.string().regex(/^\d{4}-\d{2}$/, "cycle must be YYYY-MM"),
  reason: z.string().trim().max(500).optional(),
});

async function ensureAccountBelongsToUser(userId: number, accountId: number): Promise<void> {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(eq(accounts.userId, userId), eq(accounts.id, accountId), notDeleted(accounts.deletedAt)),
    )
    .limit(1);
  if (!row) throw new Error("account_not_found");
}

function revalidateSurfaces(accountId: number, cycle: string): void {
  revalidatePath("/");
  revalidatePath("/settings/accounts");
  revalidatePath(`/settings/accounts/${accountId}/consolidate/${cycle}`);
}

// Idempotent: a second call against an already-live skip is a no-op and still
// returns ok (the UI doesn't need to distinguish).
export async function skipCycleAction(formData: FormData): Promise<{ ok: true }> {
  const session = await getSessionUser();
  const parsed = skipSchema.parse({
    accountId: formData.get("accountId"),
    cycle: formData.get("cycle"),
    reason: formData.get("reason") ?? undefined,
  });

  await ensureAccountBelongsToUser(session.id, parsed.accountId);

  const [existing] = await db
    .select({ id: skippedConsolidationCycles.id })
    .from(skippedConsolidationCycles)
    .where(
      and(
        eq(skippedConsolidationCycles.userId, session.id),
        eq(skippedConsolidationCycles.accountId, parsed.accountId),
        eq(skippedConsolidationCycles.cycle, parsed.cycle),
        notDeleted(skippedConsolidationCycles.deletedAt),
      ),
    )
    .limit(1);
  if (existing) {
    log.info(
      { userId: session.id, accountId: parsed.accountId, cycle: parsed.cycle, event: "skip_noop" },
      "skip cycle: already skipped, no-op",
    );
    revalidateSurfaces(parsed.accountId, parsed.cycle);
    return { ok: true };
  }

  await db.insert(skippedConsolidationCycles).values({
    userId: session.id,
    accountId: parsed.accountId,
    cycle: parsed.cycle,
    reason: parsed.reason ?? null,
  });

  log.info(
    {
      userId: session.id,
      accountId: parsed.accountId,
      cycle: parsed.cycle,
      reason: parsed.reason ?? null,
      event: "skip_created",
    },
    "skip cycle: created",
  );

  revalidateSurfaces(parsed.accountId, parsed.cycle);
  return { ok: true };
}

const unskipSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  cycle: z.string().regex(/^\d{4}-\d{2}$/, "cycle must be YYYY-MM"),
});

export async function unskipCycleAction(formData: FormData): Promise<{ ok: true }> {
  const session = await getSessionUser();
  const parsed = unskipSchema.parse({
    accountId: formData.get("accountId"),
    cycle: formData.get("cycle"),
  });

  await ensureAccountBelongsToUser(session.id, parsed.accountId);

  // Soft-delete the live row if one exists. Missing or already-deleted rows
  // are treated as a no-op so the UI can retry safely.
  await db
    .update(skippedConsolidationCycles)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(skippedConsolidationCycles.userId, session.id),
        eq(skippedConsolidationCycles.accountId, parsed.accountId),
        eq(skippedConsolidationCycles.cycle, parsed.cycle),
        notDeleted(skippedConsolidationCycles.deletedAt),
      ),
    );

  log.info(
    {
      userId: session.id,
      accountId: parsed.accountId,
      cycle: parsed.cycle,
      event: "skip_removed",
    },
    "skip cycle: removed (soft-delete)",
  );

  revalidateSurfaces(parsed.accountId, parsed.cycle);
  return { ok: true };
}
