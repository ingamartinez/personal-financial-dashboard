"use server";

import { revalidatePath } from "next/cache";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  accounts,
  categories,
  recurringTransactions,
  transactions,
} from "@/lib/db/schema";
import { classifyByRule } from "@/lib/classification/rules";
import { yearMonth } from "@/lib/recurring/upcoming";

const upsertSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  accountId: z.coerce.number().int().positive(),
  label: z.string().min(1).max(120),
  amount: z.coerce.number().finite(),
  direction: z.enum(["expense", "income"]),
  categorySlug: z.string().min(1).max(60).nullable(),
  dayOfMonth: z.coerce.number().int().min(1).max(31),
  active: z.coerce.boolean().default(true),
  notes: z.string().max(500).nullable(),
});

export type RecurringInput = z.input<typeof upsertSchema>;

function revalidate() {
  revalidatePath("/");
  revalidatePath("/transactions");
  revalidatePath("/settings/recurring");
}

export async function upsertRecurring(input: RecurringInput) {
  const parsed = upsertSchema.parse(input);

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

  const signedCents =
    Math.round(Math.abs(parsed.amount) * 100) *
    (parsed.direction === "income" ? 1 : -1);

  const values = {
    accountId: parsed.accountId,
    label: parsed.label,
    amountCents: BigInt(signedCents),
    currency: account.currency,
    categorySlug: parsed.categorySlug,
    dayOfMonth: parsed.dayOfMonth,
    active: parsed.active,
    notes: parsed.notes,
  };

  if (parsed.id) {
    await db
      .update(recurringTransactions)
      .set(values)
      .where(eq(recurringTransactions.id, parsed.id));
  } else {
    await db.insert(recurringTransactions).values(values);
  }

  revalidate();
}

export async function deleteRecurring(id: number) {
  await db
    .delete(recurringTransactions)
    .where(eq(recurringTransactions.id, id));
  revalidate();
}

export async function toggleRecurringActive(id: number, active: boolean) {
  await db
    .update(recurringTransactions)
    .set({ active })
    .where(eq(recurringTransactions.id, id));
  revalidate();
}

const dismissSchema = z.object({
  recurringId: z.coerce.number().int().positive(),
  ym: z.string().regex(/^\d{4}-\d{2}$/),
});

export async function dismissUpcoming(input: z.input<typeof dismissSchema>) {
  const { recurringId, ym } = dismissSchema.parse(input);
  const [row] = await db
    .select({ skippedMonths: recurringTransactions.skippedMonths })
    .from(recurringTransactions)
    .where(eq(recurringTransactions.id, recurringId))
    .limit(1);
  if (!row) throw new Error("Recurring not found");
  const next = Array.from(new Set([...(row.skippedMonths ?? []), ym]));
  await db
    .update(recurringTransactions)
    .set({ skippedMonths: next })
    .where(eq(recurringTransactions.id, recurringId));
  revalidate();
}

export async function undismissUpcoming(input: z.input<typeof dismissSchema>) {
  const { recurringId, ym } = dismissSchema.parse(input);
  const [row] = await db
    .select({ skippedMonths: recurringTransactions.skippedMonths })
    .from(recurringTransactions)
    .where(eq(recurringTransactions.id, recurringId))
    .limit(1);
  if (!row) throw new Error("Recurring not found");
  const next = (row.skippedMonths ?? []).filter((m) => m !== ym);
  await db
    .update(recurringTransactions)
    .set({ skippedMonths: next })
    .where(eq(recurringTransactions.id, recurringId));
  revalidate();
}

const promoteSchema = z.object({
  recurringId: z.coerce.number().int().positive(),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function promoteUpcoming(input: z.input<typeof promoteSchema>) {
  const { recurringId, occurredOn } = promoteSchema.parse(input);

  const [r] = await db
    .select({
      id: recurringTransactions.id,
      accountId: recurringTransactions.accountId,
      label: recurringTransactions.label,
      amountCents: recurringTransactions.amountCents,
      currency: recurringTransactions.currency,
      categorySlug: recurringTransactions.categorySlug,
      notes: recurringTransactions.notes,
    })
    .from(recurringTransactions)
    .where(eq(recurringTransactions.id, recurringId))
    .limit(1);
  if (!r) throw new Error("Recurring not found");

  const occurredAt = new Date(`${occurredOn}T12:00:00Z`);
  const monthStart = new Date(
    Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth(), 1),
  );
  const monthEnd = new Date(
    Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth() + 1, 0, 23, 59, 59),
  );

  const [dup] = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, r.accountId),
        eq(transactions.amountCents, r.amountCents),
        gte(transactions.occurredAt, monthStart),
        lte(transactions.occurredAt, monthEnd),
      ),
    )
    .limit(1);
  if (dup) throw new Error(`Already exists this month as tx #${dup.id}`);

  const cls = r.categorySlug
    ? null
    : await classifyByRule({ descriptionRaw: r.label });

  await db.insert(transactions).values({
    accountId: r.accountId,
    occurredAt,
    amountCents: r.amountCents,
    currency: r.currency,
    descriptionRaw: r.label,
    descriptionClean: null,
    merchant: null,
    categorySlug: r.categorySlug ?? cls?.categorySlug ?? null,
    classificationMethod: r.categorySlug
      ? "manual"
      : cls
        ? "rule"
        : "unclassified",
    classificationConfidence: r.categorySlug ? 100 : (cls?.confidence ?? null),
    source: "recurring",
    notes: r.notes,
    rawData: sql`${JSON.stringify({ promotedFromRecurringId: r.id })}::jsonb`,
  });

  revalidate();
}

export { yearMonth };
