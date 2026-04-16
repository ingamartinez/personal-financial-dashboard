"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  accounts,
  categories,
  counterparties,
  transactions,
} from "@/lib/db/schema";
import { classifyUnclassifiedBatch } from "@/lib/classification/pipeline";
import { emit } from "@/lib/events/bus";

const updateSchema = z.object({
  txId: z.coerce.number().int().positive(),
  categorySlug: z.string().min(1).max(60).nullable(),
});

export async function updateTransactionCategory(input: {
  txId: number;
  categorySlug: string | null;
}) {
  const { txId, categorySlug } = updateSchema.parse(input);

  await db
    .update(transactions)
    .set({
      categorySlug,
      classificationMethod: categorySlug ? "manual" : "unclassified",
      classificationConfidence: categorySlug ? 100 : null,
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, txId));

  revalidatePath("/transactions");
}

const expenseSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  amount: z.coerce.number().positive().finite(),
  categorySlug: z.string().min(1).max(60).nullable(),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().max(500).nullable(),
});

export async function createManualExpense(input: {
  accountId: number;
  amount: number;
  categorySlug: string | null;
  occurredOn: string;
  notes: string | null;
}) {
  const parsed = expenseSchema.parse(input);

  const [account] = await db
    .select({ id: accounts.id, currency: accounts.currency })
    .from(accounts)
    .where(eq(accounts.id, parsed.accountId))
    .limit(1);

  if (!account) throw new Error("Account not found");

  if (parsed.categorySlug) {
    const [cat] = await db
      .select({ slug: categories.slug })
      .from(categories)
      .where(eq(categories.slug, parsed.categorySlug))
      .limit(1);
    if (!cat) throw new Error("Category not found");
  }

  const cents = Math.round(parsed.amount * 100);
  const occurredAt = new Date(`${parsed.occurredOn}T12:00:00Z`);

  const [inserted] = await db
    .insert(transactions)
    .values({
      accountId: account.id,
      occurredAt,
      amountCents: BigInt(-cents),
      currency: account.currency,
      descriptionRaw: parsed.notes ?? "Manual expense",
      descriptionClean: null,
      merchant: null,
      categorySlug: parsed.categorySlug,
      classificationMethod: parsed.categorySlug ? "manual" : "unclassified",
      classificationConfidence: parsed.categorySlug ? 100 : null,
      source: "manual",
      notes: parsed.notes,
    })
    .returning({ id: transactions.id });

  revalidatePath("/");
  revalidatePath("/transactions");

  emit({
    type: "transaction:created",
    id: inserted.id,
    source: "manual",
    timestamp: Date.now(),
  });
}

export async function runAiClassifier() {
  const result = await classifyUnclassifiedBatch();
  revalidatePath("/");
  revalidatePath("/transactions");
  return result;
}

const counterpartyTypeSchema = z.enum(["person", "merchant", "unknown"]);

const updateCounterpartySchema = z.object({
  id: z.coerce.number().int().positive(),
  displayName: z.string().trim().min(1).max(120),
  type: counterpartyTypeSchema,
  defaultCategorySlug: z.string().min(1).max(60).nullable(),
  notes: z.string().max(500).nullable(),
});

export type UpdateCounterpartyInput = z.input<typeof updateCounterpartySchema>;
export type UpdateCounterpartyResult = {
  propagatedCount: number;
};

/**
 * Update a counterparty (rename, set type, set default category, notes).
 *
 * When defaultCategorySlug is set, propagates to all LINKED transactions that
 * are still unclassified (category_slug IS NULL). Manually-classified tx are
 * preserved — user intent wins over counterparty defaults.
 *
 * Returns the number of transactions whose category was updated by this call,
 * for user feedback in the UI toast.
 */
export async function updateCounterparty(
  input: UpdateCounterpartyInput,
): Promise<UpdateCounterpartyResult> {
  const parsed = updateCounterpartySchema.parse(input);

  if (parsed.defaultCategorySlug) {
    const [cat] = await db
      .select({ slug: categories.slug })
      .from(categories)
      .where(eq(categories.slug, parsed.defaultCategorySlug))
      .limit(1);
    if (!cat) throw new Error("Category not found");
  }

  const propagatedCount = await db.transaction(async (trx) => {
    await trx
      .update(counterparties)
      .set({
        displayName: parsed.displayName,
        type: parsed.type,
        defaultCategorySlug: parsed.defaultCategorySlug,
        notes: parsed.notes,
        updatedAt: new Date(),
      })
      .where(eq(counterparties.id, parsed.id));

    if (!parsed.defaultCategorySlug) return 0;

    const updated = await trx.execute<{ id: number }>(sql`
      UPDATE transactions SET
        category_slug = ${parsed.defaultCategorySlug},
        classification_method = 'rule'::classification_method,
        classification_confidence = 100,
        updated_at = now()
      WHERE counterparty_id = ${parsed.id}
        AND category_slug IS NULL
      RETURNING id
    `);
    return updated.length;
  });

  if (propagatedCount > 0) {
    emit({
      type: "transaction:bulk-updated",
      count: propagatedCount,
      reason: "counterparty-updated",
      timestamp: Date.now(),
    });
  }

  revalidatePath("/");
  revalidatePath("/transactions");

  return { propagatedCount };
}

const mergeCounterpartySchema = z
  .object({
    sourceId: z.coerce.number().int().positive(),
    targetId: z.coerce.number().int().positive(),
  })
  .refine((v) => v.sourceId !== v.targetId, {
    message: "sourceId and targetId must differ",
  });

export type MergeCounterpartyInput = z.input<typeof mergeCounterpartySchema>;
export type MergeCounterpartyResult = {
  movedTxCount: number;
  movedAliasCount: number;
  inheritedCategoryFromSource: boolean;
};

/**
 * Merges source counterparty into target: aliases and transactions are moved,
 * source is deleted. If target has no default_category and source does, the
 * category is inherited so users don't lose classification work.
 *
 * Alias collisions (same kind+value on both sides) shouldn't happen in
 * practice because unique constraint would have prevented it at ingest. If it
 * ever does, the source alias is silently dropped.
 */
export async function mergeCounterparty(
  input: MergeCounterpartyInput,
): Promise<MergeCounterpartyResult> {
  const parsed = mergeCounterpartySchema.parse(input);

  const result = await db.transaction(async (trx) => {
    const [target] = await trx
      .select({
        id: counterparties.id,
        defaultCategorySlug: counterparties.defaultCategorySlug,
      })
      .from(counterparties)
      .where(eq(counterparties.id, parsed.targetId))
      .limit(1);
    const [source] = await trx
      .select({
        id: counterparties.id,
        defaultCategorySlug: counterparties.defaultCategorySlug,
        hitCount: counterparties.hitCount,
      })
      .from(counterparties)
      .where(eq(counterparties.id, parsed.sourceId))
      .limit(1);

    if (!target) throw new Error("Target counterparty not found");
    if (!source) throw new Error("Source counterparty not found");

    const inheritCategory =
      !target.defaultCategorySlug && !!source.defaultCategorySlug;
    if (inheritCategory) {
      await trx
        .update(counterparties)
        .set({
          defaultCategorySlug: source.defaultCategorySlug,
          updatedAt: new Date(),
        })
        .where(eq(counterparties.id, target.id));
    }

    // Move aliases (drop any that would violate unique kind+value on target).
    const aliasMove = await trx.execute<{ id: number }>(sql`
      UPDATE counterparty_aliases
      SET counterparty_id = ${target.id}
      WHERE counterparty_id = ${source.id}
        AND NOT EXISTS (
          SELECT 1 FROM counterparty_aliases existing
          WHERE existing.counterparty_id = ${target.id}
            AND existing.kind = counterparty_aliases.kind
            AND existing.value = counterparty_aliases.value
        )
      RETURNING id
    `);

    // Reapunta todas las tx del source al target.
    const txMove = await trx.execute<{ id: number }>(sql`
      UPDATE transactions
      SET counterparty_id = ${target.id}, updated_at = now()
      WHERE counterparty_id = ${source.id}
      RETURNING id
    `);

    // Accumulate hit_count so the merged entity reflects combined history.
    await trx.execute(sql`
      UPDATE counterparties
      SET hit_count = hit_count + ${source.hitCount},
          updated_at = now()
      WHERE id = ${target.id}
    `);

    // Source counterparty (and any residual aliases / refs with SET NULL on
    // tx FK — already moved above) removed. CASCADE cleans aliases.
    await trx
      .delete(counterparties)
      .where(eq(counterparties.id, source.id));

    return {
      movedTxCount: txMove.length,
      movedAliasCount: aliasMove.length,
      inheritedCategoryFromSource: inheritCategory,
    };
  });

  emit({
    type: "transaction:bulk-updated",
    count: result.movedTxCount,
    reason: "counterparty-updated",
    timestamp: Date.now(),
  });

  revalidatePath("/");
  revalidatePath("/transactions");

  return result;
}
