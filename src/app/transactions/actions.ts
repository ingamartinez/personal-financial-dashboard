"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";

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
