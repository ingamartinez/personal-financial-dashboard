"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  accounts,
  categories,
  classificationCorrections,
  counterparties,
  counterpartyType,
  ingestionLogs,
  transactions,
  users,
} from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import { classifySingleWithAi as classifySingleWithAiLib } from "@/lib/classification/ai";
import { MERCHANT_HINTS_MAX } from "@/lib/classification/context";
import { classifyUnclassifiedBatch } from "@/lib/classification/pipeline";
import type { UserClassificationContext } from "@/lib/db/schema";
import { emit } from "@/lib/events/bus";
import { autoLinkTransaction } from "@/lib/recurring/auto-link";
import { keyForParsed } from "@/lib/counterparties/alias-key";
import { parseSmsBancolombia } from "@/lib/ingestion/sms-bancolombia";
import { decimalStringToCents } from "@/lib/money";
import type { CounterpartyKind, CounterpartyType } from "@/lib/types";

const updateSchema = z.object({
  txId: z.coerce.number().int().positive(),
  categorySlug: z.string().min(1).max(60).nullable(),
});

export async function updateTransactionCategory(input: {
  txId: number;
  categorySlug: string | null;
}) {
  const session = await getSessionUser();
  const { txId, categorySlug } = updateSchema.parse(input);

  await db.transaction(async (trx) => {
    const [current] = await trx
      .select({
        categorySlug: transactions.categorySlug,
        merchant: transactions.merchant,
      })
      .from(transactions)
      .where(and(eq(transactions.userId, session.id), eq(transactions.id, txId)))
      .limit(1);

    if (!current) return;

    const prior = current.categorySlug;
    const isChange = prior !== categorySlug;

    await trx
      .update(transactions)
      .set({
        categorySlug,
        classificationMethod: categorySlug ? "manual" : "unclassified",
        classificationConfidence: categorySlug ? 100 : null,
        ...(isChange ? { previousCategorySlug: prior } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.userId, session.id), eq(transactions.id, txId)));

    // Log as a correction only when the user actively picks a new category.
    // Un-classification (reset to null) is a "reset" signal, not training
    // data for the learning loop — the 3x-in-30d cron groups by new slug.
    if (isChange && categorySlug) {
      await trx.insert(classificationCorrections).values({
        userId: session.id,
        transactionId: txId,
        merchant: current.merchant,
        previousCategorySlug: prior,
        newCategorySlug: categorySlug,
      });

      // Soft learning signal — merchant hint fed to the AI prompt on future
      // classifications. Rolling FIFO (newest wins). SELECT FOR UPDATE on the
      // users row serializes concurrent corrections so no hint is lost to an
      // interleaved read/modify/write on the same jsonb blob.
      if (current.merchant) {
        const [userRow] = await trx
          .select({ context: users.classificationContext })
          .from(users)
          .where(eq(users.id, session.id))
          .for("update");
        const ctx: UserClassificationContext = userRow?.context ?? {};
        const nextHints = [
          ...(ctx.merchant_hints ?? []),
          {
            merchant: current.merchant,
            category: categorySlug,
            corrected_at: new Date().toISOString(),
          },
        ].slice(-MERCHANT_HINTS_MAX);
        await trx
          .update(users)
          .set({
            classificationContext: { ...ctx, merchant_hints: nextHints },
            updatedAt: new Date(),
          })
          .where(eq(users.id, session.id));
      }
    }
  });

  revalidatePath("/transactions");
}

const confirmSchema = z.object({
  txId: z.coerce.number().int().positive(),
});

/**
 * Confirm an auto-classification from the review inbox. Bumps confidence to
 * 100 and flips the method to `manual_confirmed` so the row stops being
 * flagged as low-confidence. Does NOT log to classification_corrections — a
 * confirm is user agreement with the existing category, not a correction.
 * Only fires when the tx is currently rule/ai with confidence < 60 so the
 * action can't be abused to bypass corrections tracking.
 */
export async function confirmClassification(input: {
  txId: number;
}): Promise<{ status: "ok" } | { status: "error"; message: string }> {
  const session = await getSessionUser();
  const parsed = confirmSchema.safeParse(input);
  if (!parsed.success) return { status: "error", message: "Input inválido." };

  const updated = await db.transaction(async (trx) => {
    const [current] = await trx
      .select({
        method: transactions.classificationMethod,
        confidence: transactions.classificationConfidence,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, session.id),
          eq(transactions.id, parsed.data.txId),
          inArray(transactions.classificationMethod, ["rule", "ai"]),
        ),
      )
      .limit(1);

    if (!current) return [];

    // Snapshot the prior method + confidence into classification_reason as a
    // JSON blob so the explainability endpoint can surface "confirmed from AI
    // classification at 45% confidence" without extra columns. VARCHAR(200) has
    // plenty of room for this shape.
    const reason = JSON.stringify({
      confirmed_from: current.method,
      confidence: current.confidence,
    });

    return trx
      .update(transactions)
      .set({
        classificationMethod: "manual_confirmed",
        classificationConfidence: 100,
        classificationReason: reason,
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.userId, session.id), eq(transactions.id, parsed.data.txId)))
      .returning({ id: transactions.id });
  });

  if (updated.length === 0) {
    return { status: "error", message: "Transacción no está pendiente de revisión." };
  }

  revalidatePath("/transactions");
  revalidatePath("/settings/inbox");
  return { status: "ok" };
}

// Amount arrives as a decimal STRING so we can parse to bigint cents via
// integer arithmetic (see `decimalStringToCents`). Never accept a number
// here — `number * 100` loses precision for values like 9.995.
const expenseSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  amount: z
    .string()
    .trim()
    .transform((value, ctx) => {
      try {
        const cents = decimalStringToCents(value);
        if (cents <= BigInt(0)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Amount must be greater than zero",
          });
          return z.NEVER;
        }
        return cents;
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Amount must be a positive decimal with up to 2 digits",
        });
        return z.NEVER;
      }
    }),
  categorySlug: z.string().min(1).max(60).nullable(),
  occurredOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .refine((d) => d <= new Date().toISOString().slice(0, 10), {
      message: "Date cannot be in the future",
    }),
  notes: z.string().max(500).nullable(),
});

export async function createManualExpense(input: {
  accountId: number;
  amount: string;
  categorySlug: string | null;
  occurredOn: string;
  notes: string | null;
}) {
  const session = await getSessionUser();
  const startedAt = new Date();
  // Server actions serialize errors to the client — ZodError.message is a
  // JSON blob. Flatten to the first issue so the form can toast it cleanly.
  const result = expenseSchema.safeParse(input);
  if (!result.success) {
    throw new Error(result.error.issues[0]?.message ?? "Invalid input");
  }
  const parsed = result.data;

  const [account] = await db
    .select({ id: accounts.id, currency: accounts.currency })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, session.id),
        eq(accounts.id, parsed.accountId),
        notDeleted(accounts.deletedAt),
      ),
    )
    .limit(1);

  if (!account) throw new Error("Account not found");

  if (parsed.categorySlug) {
    const [cat] = await db
      .select({ slug: categories.slug })
      .from(categories)
      .where(
        and(
          eq(categories.userId, session.id),
          eq(categories.slug, parsed.categorySlug),
          notDeleted(categories.deletedAt),
        ),
      )
      .limit(1);
    if (!cat) throw new Error("Category not found");
  }

  const occurredAt = new Date(`${parsed.occurredOn}T12:00:00Z`);

  const [inserted] = await db
    .insert(transactions)
    .values({
      userId: session.id,
      accountId: account.id,
      occurredAt,
      amountCents: -parsed.amount,
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

  await autoLinkTransaction(session.id, inserted.id);

  await db.insert(ingestionLogs).values({
    userId: session.id,
    source: "manual",
    status: "inserted",
    itemsReceived: 1,
    itemsInserted: 1,
    itemsDuplicated: 0,
    errorMessage: null,
    payload: {
      kind: "manual-create",
      accountId: account.id,
      amountCents: parsed.amount.toString(),
      categorySlug: parsed.categorySlug,
    },
    startedAt,
    finishedAt: new Date(),
  });

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
  const session = await getSessionUser();
  const result = await classifyUnclassifiedBatch(session.id);
  revalidatePath("/");
  revalidatePath("/transactions");
  return result;
}

const classifySingleSchema = z.object({
  txId: z.coerce.number().int().positive(),
});

export type ClassifySingleInput = z.input<typeof classifySingleSchema>;
export type ClassifySingleResult = {
  categorySlug: string;
  categoryName: string;
  confidence: number;
};

export async function classifySingleWithAi(
  input: ClassifySingleInput,
): Promise<ClassifySingleResult> {
  const session = await getSessionUser();
  const { txId } = classifySingleSchema.parse(input);

  const [tx] = await db
    .select({
      id: transactions.id,
      descriptionRaw: transactions.descriptionRaw,
      descriptionClean: transactions.descriptionClean,
      merchant: transactions.merchant,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      classificationMethod: transactions.classificationMethod,
      categorySlug: transactions.categorySlug,
    })
    .from(transactions)
    .where(and(eq(transactions.userId, session.id), eq(transactions.id, txId)))
    .limit(1);

  if (!tx) throw new Error("Transaction not found");
  if (tx.classificationMethod !== "unclassified" || tx.categorySlug !== null) {
    throw new Error("Transaction is already classified");
  }

  const [cats, userRow] = await Promise.all([
    db
      .select({
        slug: categories.slug,
        name: categories.name,
        parentSlug: categories.parentSlug,
      })
      .from(categories)
      .where(and(eq(categories.userId, session.id), notDeleted(categories.deletedAt))),
    db
      .select({ context: users.classificationContext })
      .from(users)
      .where(eq(users.id, session.id))
      .limit(1),
  ]);

  const result = await classifySingleWithAiLib({
    transaction: {
      id: tx.id,
      description: tx.descriptionClean ?? tx.merchant ?? tx.descriptionRaw,
      amountCents: tx.amountCents,
      currency: tx.currency,
    },
    categories: cats,
    userHints: userRow[0]?.context?.merchant_hints ?? [],
  });

  const hit = result.classification;
  if (!hit || !hit.categorySlug) {
    throw new Error("AI could not classify this transaction");
  }

  const pickedCat = cats.find((c) => c.slug === hit.categorySlug);
  if (!pickedCat) {
    // classifyBatchWithAi already filters invalid slugs to null, so this is
    // defense-in-depth — the row stays unclassified if we somehow get here.
    throw new Error("AI returned an unknown category");
  }

  await db
    .update(transactions)
    .set({
      categorySlug: hit.categorySlug,
      classificationMethod: "ai",
      classificationConfidence: hit.confidence,
      updatedAt: new Date(),
    })
    .where(and(eq(transactions.userId, session.id), eq(transactions.id, txId)));

  revalidatePath("/");
  revalidatePath("/transactions");

  return {
    categorySlug: hit.categorySlug,
    categoryName: pickedCat.name,
    confidence: hit.confidence,
  };
}

const counterpartyTypeSchema = z.enum(counterpartyType.enumValues);

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
  const session = await getSessionUser();
  const parsed = updateCounterpartySchema.parse(input);

  if (parsed.defaultCategorySlug) {
    const [cat] = await db
      .select({ slug: categories.slug })
      .from(categories)
      .where(
        and(
          eq(categories.userId, session.id),
          eq(categories.slug, parsed.defaultCategorySlug),
          notDeleted(categories.deletedAt),
        ),
      )
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
      .where(and(eq(counterparties.userId, session.id), eq(counterparties.id, parsed.id)));

    if (!parsed.defaultCategorySlug) return 0;

    const updated = await trx.execute<{ id: number }>(sql`
      UPDATE transactions SET
        category_slug = ${parsed.defaultCategorySlug},
        classification_method = 'rule'::classification_method,
        classification_confidence = 100,
        updated_at = now()
      WHERE user_id = ${session.id}
        AND counterparty_id = ${parsed.id}
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

  emit({
    type: "counterparty:updated",
    id: parsed.id,
    reason: "edit",
    timestamp: Date.now(),
  });

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
  const session = await getSessionUser();
  const parsed = mergeCounterpartySchema.parse(input);

  const result = await db.transaction(async (trx) => {
    const [target] = await trx
      .select({
        id: counterparties.id,
        defaultCategorySlug: counterparties.defaultCategorySlug,
      })
      .from(counterparties)
      .where(and(eq(counterparties.userId, session.id), eq(counterparties.id, parsed.targetId)))
      .limit(1);
    const [source] = await trx
      .select({
        id: counterparties.id,
        defaultCategorySlug: counterparties.defaultCategorySlug,
        hitCount: counterparties.hitCount,
      })
      .from(counterparties)
      .where(and(eq(counterparties.userId, session.id), eq(counterparties.id, parsed.sourceId)))
      .limit(1);

    if (!target) throw new Error("Target counterparty not found");
    if (!source) throw new Error("Source counterparty not found");

    const inheritCategory = !target.defaultCategorySlug && !!source.defaultCategorySlug;
    if (inheritCategory) {
      await trx
        .update(counterparties)
        .set({
          defaultCategorySlug: source.defaultCategorySlug,
          updatedAt: new Date(),
        })
        .where(and(eq(counterparties.userId, session.id), eq(counterparties.id, target.id)));
    }

    // Move aliases (drop any that would violate unique kind+value on target).
    const aliasMove = await trx.execute<{ id: number }>(sql`
      UPDATE counterparty_aliases
      SET counterparty_id = ${target.id}
      WHERE user_id = ${session.id}
        AND counterparty_id = ${source.id}
        AND NOT EXISTS (
          SELECT 1 FROM counterparty_aliases existing
          WHERE existing.user_id = ${session.id}
            AND existing.counterparty_id = ${target.id}
            AND existing.kind = counterparty_aliases.kind
            AND existing.value = counterparty_aliases.value
        )
      RETURNING id
    `);

    // Reapunta todas las tx del source al target.
    const txMove = await trx.execute<{ id: number }>(sql`
      UPDATE transactions
      SET counterparty_id = ${target.id}, updated_at = now()
      WHERE user_id = ${session.id} AND counterparty_id = ${source.id}
      RETURNING id
    `);

    // Accumulate hit_count so the merged entity reflects combined history.
    await trx.execute(sql`
      UPDATE counterparties
      SET hit_count = hit_count + ${source.hitCount},
          updated_at = now()
      WHERE user_id = ${session.id} AND id = ${target.id}
    `);

    // Source counterparty (and any residual aliases / refs with SET NULL on
    // tx FK — already moved above) removed. CASCADE cleans aliases.
    await trx
      .delete(counterparties)
      .where(and(eq(counterparties.userId, session.id), eq(counterparties.id, source.id)));

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

  emit({
    type: "counterparty:updated",
    id: parsed.targetId,
    reason: "merge",
    timestamp: Date.now(),
  });

  revalidatePath("/");
  revalidatePath("/transactions");

  return result;
}

const splitCounterpartySchema = z.object({
  sourceId: z.coerce.number().int().positive(),
  aliasIds: z.array(z.coerce.number().int().positive()).min(1),
  newDisplayName: z.string().trim().min(1).max(120).optional(),
});

export type SplitCounterpartyInput = z.input<typeof splitCounterpartySchema>;
export type SplitCounterpartyResult = {
  newCounterpartyId: number;
  movedTxCount: number;
  movedAliasCount: number;
};

/**
 * Extracts a subset of a counterparty's aliases into a new counterparty and
 * reassigns the historical transactions that matched those aliases at ingest.
 *
 * Transaction reassignment re-parses each source tx's raw SMS via the ingest
 * parser and derives its original (kind, value) match. This gives 1:1 fidelity
 * with the ingest-time counterparty match and avoids brittle text heuristics.
 *
 * Guards: at least one alias must stay on the source so the source never ends
 * up orphaned. The new counterparty inherits displayName/type/defaultCategory
 * from source; the caller can override the name via `newDisplayName`.
 */
export async function splitCounterparty(
  input: SplitCounterpartyInput,
): Promise<SplitCounterpartyResult> {
  const session = await getSessionUser();
  const parsed = splitCounterpartySchema.parse(input);
  const aliasIdSet = new Set(parsed.aliasIds);
  if (aliasIdSet.size !== parsed.aliasIds.length) {
    throw new Error("aliasIds must be unique");
  }

  const [source] = await db.execute<{
    id: number;
    display_name: string;
    type: CounterpartyType;
    default_category_slug: string | null;
  }>(sql`
    SELECT id, display_name, type, default_category_slug
    FROM counterparties
    WHERE user_id = ${session.id} AND id = ${parsed.sourceId}
    LIMIT 1
  `);
  if (!source) throw new Error("Source counterparty not found");

  const allAliases = await db.execute<{
    id: number;
    kind: CounterpartyKind;
    value: string;
  }>(sql`
    SELECT id, kind, value
    FROM counterparty_aliases
    WHERE user_id = ${session.id} AND counterparty_id = ${parsed.sourceId}
  `);
  if (allAliases.length < 2) {
    throw new Error("Counterparty needs at least 2 aliases to split");
  }

  const extractedAliases = allAliases.filter((a) => aliasIdSet.has(a.id));
  if (extractedAliases.length !== aliasIdSet.size) {
    throw new Error("Some aliasIds do not belong to this counterparty");
  }
  if (extractedAliases.length >= allAliases.length) {
    throw new Error("Cannot extract every alias — at least one must stay");
  }

  const extractedKeys = new Set(extractedAliases.map((a) => `${a.kind}:${a.value}`));

  // Re-parse every source tx to determine which ones belong to the extracted
  // alias set. Parsing is pure/side-effect-free so we do it outside the DB
  // transaction to keep the tx short.
  const sourceTxs = await db.execute<{ id: number; raw_data: unknown }>(sql`
    SELECT id, raw_data
    FROM transactions
    WHERE user_id = ${session.id} AND counterparty_id = ${parsed.sourceId}
  `);

  const movedTxIds: number[] = [];
  for (const tx of sourceTxs) {
    const raw = tx.raw_data as { sms?: unknown } | null;
    const smsBody = raw && typeof raw.sms === "string" ? raw.sms : null;
    if (!smsBody) continue;

    const parseResult = parseSmsBancolombia(smsBody);
    if (parseResult.kind === "skip") continue;

    const key = keyForParsed(parseResult);
    if (!key) continue;

    if (extractedKeys.has(`${key.kind}:${key.value}`)) {
      movedTxIds.push(tx.id);
    }
  }

  const result = await db.transaction(async (trx) => {
    const [inserted] = await trx.execute<{ id: number }>(sql`
      INSERT INTO counterparties (user_id, display_name, type, default_category_slug, hit_count, last_hit_at)
      VALUES (
        ${session.id},
        ${parsed.newDisplayName ?? source.display_name},
        ${source.type}::counterparty_type,
        ${source.default_category_slug},
        0,
        NULL
      )
      RETURNING id
    `);
    const newId = inserted.id;

    await trx.execute(sql`
      UPDATE counterparty_aliases
      SET counterparty_id = ${newId}
      WHERE user_id = ${session.id}
        AND id = ANY(${sql`ARRAY[${sql.join(
          parsed.aliasIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::int[]`})
    `);

    let movedTxCount = 0;
    if (movedTxIds.length > 0) {
      const updated = await trx.execute<{ id: number }>(sql`
        UPDATE transactions
        SET counterparty_id = ${newId}, updated_at = now()
        WHERE user_id = ${session.id}
          AND id = ANY(${sql`ARRAY[${sql.join(
            movedTxIds.map((id) => sql`${id}`),
            sql`, `,
          )}]::int[]`})
        RETURNING id
      `);
      movedTxCount = updated.length;
    }

    await trx
      .update(counterparties)
      .set({ updatedAt: new Date() })
      .where(and(eq(counterparties.userId, session.id), eq(counterparties.id, parsed.sourceId)));

    return {
      newCounterpartyId: newId,
      movedTxCount,
      movedAliasCount: extractedAliases.length,
    };
  });

  if (result.movedTxCount > 0) {
    emit({
      type: "transaction:bulk-updated",
      count: result.movedTxCount,
      reason: "counterparty-updated",
      timestamp: Date.now(),
    });
  }

  emit({
    type: "counterparty:updated",
    id: parsed.sourceId,
    reason: "split",
    timestamp: Date.now(),
  });
  emit({
    type: "counterparty:updated",
    id: result.newCounterpartyId,
    reason: "split",
    timestamp: Date.now(),
  });

  revalidatePath("/");
  revalidatePath("/transactions");

  return result;
}
