"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { accounts, categories, transactions } from "@/lib/db/schema";
import { classifyUnclassifiedBatch } from "@/lib/classification/pipeline";

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

  await db.insert(transactions).values({
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
  });

  revalidatePath("/");
  revalidatePath("/transactions");
}

export async function runAiClassifier() {
  const result = await classifyUnclassifiedBatch();
  revalidatePath("/");
  revalidatePath("/transactions");
  return result;
}
