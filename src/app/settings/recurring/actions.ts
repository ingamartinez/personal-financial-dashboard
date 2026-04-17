"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  accounts,
  categories,
  recurringGaps,
  recurringTransactions,
  transactions,
} from "@/lib/db/schema";
import { classifyByRule } from "@/lib/classification/rules";
import { emit } from "@/lib/events/bus";
import { getLinkCandidates, type LinkCandidate } from "@/lib/recurring/gap-queries";
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
    Math.round(Math.abs(parsed.amount) * 100) * (parsed.direction === "income" ? 1 : -1);

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
  await db.delete(recurringTransactions).where(eq(recurringTransactions.id, id));
  revalidate();
}

export async function toggleRecurringActive(id: number, active: boolean) {
  await db.update(recurringTransactions).set({ active }).where(eq(recurringTransactions.id, id));
  revalidate();
}

const dismissSchema = z.object({
  recurringId: z.coerce.number().int().positive(),
  ym: z.string().regex(/^\d{4}-\d{2}$/),
});

export async function dismissUpcoming(input: z.input<typeof dismissSchema>) {
  const { recurringId, ym } = dismissSchema.parse(input);

  const result = await db.transaction(async (trx) => {
    const [row] = await trx
      .select({ skippedMonths: recurringTransactions.skippedMonths })
      .from(recurringTransactions)
      .where(eq(recurringTransactions.id, recurringId))
      .limit(1);
    if (!row) throw new Error("Recurring not found");
    const next = Array.from(new Set([...(row.skippedMonths ?? []), ym]));
    await trx
      .update(recurringTransactions)
      .set({ skippedMonths: next })
      .where(eq(recurringTransactions.id, recurringId));

    const deleted = await trx
      .delete(recurringGaps)
      .where(and(eq(recurringGaps.recurringId, recurringId), eq(recurringGaps.yearMonth, ym)))
      .returning({ id: recurringGaps.id });
    return { gapId: deleted[0]?.id ?? null };
  });

  emit({
    type: "recurring-gap:resolved",
    gapId: result.gapId,
    reason: "skipped",
    timestamp: Date.now(),
  });

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
  yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountCents: z.union([z.bigint(), z.string().regex(/^-?\d+$/), z.number().int()]).optional(),
});

export type PromoteUpcomingInput = z.input<typeof promoteSchema>;

export async function promoteUpcoming(input: PromoteUpcomingInput) {
  const { recurringId, yearMonth: ym, occurredOn, amountCents } = promoteSchema.parse(input);

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

  const [dup] = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.recurringId, r.id), eq(transactions.recurringYearMonth, ym)))
    .limit(1);
  if (dup) throw new Error(`Already covered this month by tx #${dup.id}`);

  const signedCents =
    amountCents !== undefined ? toBigInt(amountCents, r.amountCents) : r.amountCents;

  const occurredAt = new Date(`${occurredOn}T12:00:00Z`);
  const cls = r.categorySlug ? null : await classifyByRule({ descriptionRaw: r.label });

  const result = await db.transaction(async (trx) => {
    const [inserted] = await trx
      .insert(transactions)
      .values({
        accountId: r.accountId,
        occurredAt,
        amountCents: signedCents,
        currency: r.currency,
        descriptionRaw: r.label,
        descriptionClean: null,
        merchant: null,
        categorySlug: r.categorySlug ?? cls?.categorySlug ?? null,
        classificationMethod: r.categorySlug ? "manual" : cls ? "rule" : "unclassified",
        classificationConfidence: r.categorySlug ? 100 : (cls?.confidence ?? null),
        source: "recurring",
        recurringId: r.id,
        recurringYearMonth: ym,
        notes: r.notes,
        rawData: sql`${JSON.stringify({ promotedFromRecurringId: r.id })}::jsonb`,
      })
      .returning({ id: transactions.id });

    const deleted = await trx
      .delete(recurringGaps)
      .where(and(eq(recurringGaps.recurringId, r.id), eq(recurringGaps.yearMonth, ym)))
      .returning({ id: recurringGaps.id });

    return { txId: inserted.id, gapId: deleted[0]?.id ?? null };
  });

  emit({
    type: "transaction:created",
    id: result.txId,
    source: "recurring",
    timestamp: Date.now(),
  });

  if (result.gapId !== null) {
    emit({
      type: "recurring-gap:resolved",
      gapId: result.gapId,
      reason: "synthetic",
      timestamp: Date.now(),
    });
  }

  revalidate();
}

function toBigInt(value: bigint | string | number, fallbackSign: bigint): bigint {
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  // If the user entered a positive number, preserve the recurring's sign
  // (expense vs income). If it's already negative, trust it.
  const ZERO = BigInt(0);
  if (parsed === ZERO) return ZERO;
  if (parsed < ZERO) return parsed;
  return fallbackSign < ZERO ? -parsed : parsed;
}

const linkTxSchema = z.object({
  txId: z.coerce.number().int().positive(),
  recurringId: z.coerce.number().int().positive(),
  yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
});

export type LinkTxToRecurringInput = z.input<typeof linkTxSchema>;

/**
 * Associate an existing transaction with a recurring for a specific month.
 * Used from the inbox when the user says "this SMS/Apple Pay tx covered
 * the arriendo/cuota/etc. of month M". Deletes the corresponding gap.
 *
 * Rejects if that (recurring, yearMonth) slot is already taken, or if the
 * tx is already linked to something else (user must unlink first).
 */
export async function linkTxToRecurring(input: LinkTxToRecurringInput) {
  const { txId, recurringId, yearMonth: ym } = linkTxSchema.parse(input);

  const result = await db.transaction(async (trx) => {
    const [tx] = await trx
      .select({ id: transactions.id, recurringId: transactions.recurringId })
      .from(transactions)
      .where(eq(transactions.id, txId))
      .limit(1);
    if (!tx) throw new Error("Transaction not found");
    if (tx.recurringId && tx.recurringId !== recurringId) {
      throw new Error("Transaction is already linked to another recurring");
    }

    const [existingLink] = await trx
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(eq(transactions.recurringId, recurringId), eq(transactions.recurringYearMonth, ym)),
      )
      .limit(1);
    if (existingLink && existingLink.id !== txId) {
      throw new Error(`Slot already taken by tx #${existingLink.id}`);
    }

    await trx
      .update(transactions)
      .set({ recurringId, recurringYearMonth: ym, updatedAt: new Date() })
      .where(eq(transactions.id, txId));

    const deleted = await trx
      .delete(recurringGaps)
      .where(and(eq(recurringGaps.recurringId, recurringId), eq(recurringGaps.yearMonth, ym)))
      .returning({ id: recurringGaps.id });

    return { gapId: deleted[0]?.id ?? null };
  });

  emit({
    type: "recurring-gap:resolved",
    gapId: result.gapId,
    reason: "linked",
    timestamp: Date.now(),
  });

  revalidate();
}

/**
 * Detach a transaction from its recurring link. Used when the user
 * incorrectly associated or auto-link picked the wrong tx. Does NOT
 * re-create a gap — if the month needs to be reconciled again, run the
 * detector or wait for the next cron.
 */
const unlinkTxSchema = z.object({
  txId: z.coerce.number().int().positive(),
});

export async function unlinkTxFromRecurring(input: z.input<typeof unlinkTxSchema>) {
  const { txId } = unlinkTxSchema.parse(input);
  await db
    .update(transactions)
    .set({ recurringId: null, recurringYearMonth: null, updatedAt: new Date() })
    .where(eq(transactions.id, txId));
  revalidate();
}

export async function fetchLinkCandidates(gapId: number): Promise<LinkCandidate[]> {
  const parsed = z.coerce.number().int().positive().parse(gapId);
  return getLinkCandidates(parsed);
}

export { yearMonth };
