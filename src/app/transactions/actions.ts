"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  accounts,
  categories,
  counterparties,
  counterpartyType,
  transactions,
} from "@/lib/db/schema";
import { classifyUnclassifiedBatch } from "@/lib/classification/pipeline";
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

// Amount arrives as a decimal STRING so we can parse to bigint cents via
// integer arithmetic (see `decimalStringToCents`). Never accept a number
// here — `number * 100` loses precision for values like 9.995.
export const expenseSchema = z.object({
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

  const occurredAt = new Date(`${parsed.occurredOn}T12:00:00Z`);

  const [inserted] = await db
    .insert(transactions)
    .values({
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

  await autoLinkTransaction(inserted.id);

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

    const inheritCategory = !target.defaultCategorySlug && !!source.defaultCategorySlug;
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
    await trx.delete(counterparties).where(eq(counterparties.id, source.id));

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
    WHERE id = ${parsed.sourceId}
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
    WHERE counterparty_id = ${parsed.sourceId}
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
    WHERE counterparty_id = ${parsed.sourceId}
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
      INSERT INTO counterparties (display_name, type, default_category_slug, hit_count, last_hit_at)
      VALUES (
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
      WHERE id = ANY(${sql`ARRAY[${sql.join(
        parsed.aliasIds.map((id) => sql`${id}`),
        sql`, `,
      )}]::int[]`})
    `);

    let movedTxCount = 0;
    if (movedTxIds.length > 0) {
      const updated = await trx.execute<{ id: number }>(sql`
        UPDATE transactions
        SET counterparty_id = ${newId}, updated_at = now()
        WHERE id = ANY(${sql`ARRAY[${sql.join(
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
      .where(eq(counterparties.id, parsed.sourceId));

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
