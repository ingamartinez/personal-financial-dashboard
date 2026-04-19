"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { budgets, categories, currency as currencyEnum } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";

const ymSchema = z.string().regex(/^\d{4}-\d{2}$/);

function monthRange(ym: string): { start: string; end: string } {
  const [y, m] = ym.split("-").map(Number);
  const start = `${ym}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${ym}-${String(lastDay).padStart(2, "0")}`;
  return { start, end };
}

const upsertSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  categorySlug: z.string().min(1).max(60),
  amount: z.coerce.number().finite().positive(),
  currency: z.enum(currencyEnum.enumValues).default("COP"),
  ym: ymSchema,
});

export type BudgetInput = z.input<typeof upsertSchema>;

function revalidate() {
  revalidatePath("/budgets");
}

export async function upsertBudget(input: BudgetInput) {
  const session = await getSessionUser();
  const parsed = upsertSchema.parse(input);
  const { start, end } = monthRange(parsed.ym);

  const [cat] = await db
    .select({ slug: categories.slug, parentSlug: categories.parentSlug })
    .from(categories)
    .where(eq(categories.slug, parsed.categorySlug))
    .limit(1);
  if (!cat) throw new Error("Category not found");
  if (cat.parentSlug !== null) {
    throw new Error("Budgets must target a root category (sub-categories roll up)");
  }

  const amountCents = BigInt(Math.round(parsed.amount * 100));

  if (parsed.id) {
    await db
      .update(budgets)
      .set({
        categorySlug: parsed.categorySlug,
        amountCents,
        currency: parsed.currency,
        periodStart: start,
        periodEnd: end,
      })
      .where(and(eq(budgets.userId, session.id), eq(budgets.id, parsed.id)));
  } else {
    const [dup] = await db
      .select({ id: budgets.id })
      .from(budgets)
      .where(
        and(
          eq(budgets.userId, session.id),
          eq(budgets.categorySlug, parsed.categorySlug),
          eq(budgets.periodStart, start),
          notDeleted(budgets.deletedAt),
        ),
      )
      .limit(1);
    if (dup) throw new Error("Budget for this category and month already exists");

    await db.insert(budgets).values({
      userId: session.id,
      categorySlug: parsed.categorySlug,
      amountCents,
      currency: parsed.currency,
      periodStart: start,
      periodEnd: end,
      active: true,
    });
  }

  revalidate();
}

export async function archiveBudget(id: number) {
  const session = await getSessionUser();
  await db
    .update(budgets)
    .set({ deletedAt: sql`NOW()` })
    .where(and(eq(budgets.userId, session.id), eq(budgets.id, id), notDeleted(budgets.deletedAt)));
  revalidate();
}
