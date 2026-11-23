"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  accounts,
  categories,
  currency as currencyEnum,
  GAP_RESOLUTION_PAID_EXTERNAL,
  recurringGaps,
  recurringTransactions,
  transactions,
} from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import { classifyByRule } from "@/lib/classification/rules";
import { emit } from "@/lib/events/bus";

const upsertSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  accountId: z.coerce.number().int().positive(),
  label: z.string().min(1).max(120),
  amount: z.coerce.number().finite(),
  direction: z.enum(["expense", "income"]),
  // Independent of the linked account's currency (#803) — the account only
  // supplies a default in the UI. When omitted, falls back to the account's
  // currency to preserve pre-#803 callers.
  currency: z.enum(currencyEnum.enumValues).optional(),
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

/**
 * #1034: the paid-external toggle also lives on /recurring, which `revalidate()`
 * does not cover. Kept separate so the pre-existing actions keep invalidating
 * exactly the paths they always did.
 */
function revalidateSlots() {
  revalidate();
  revalidatePath("/recurring");
}

export async function upsertRecurring(input: RecurringInput) {
  const session = await getSessionUser();
  const parsed = upsertSchema.parse(input);

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

  const signedCents =
    Math.round(Math.abs(parsed.amount) * 100) * (parsed.direction === "income" ? 1 : -1);

  const values = {
    userId: session.id,
    accountId: parsed.accountId,
    label: parsed.label,
    amountCents: BigInt(signedCents),
    // #803: the user's chosen currency wins; the account is only a fallback
    // default, never an override of an explicit selection.
    currency: parsed.currency ?? account.currency,
    categorySlug: parsed.categorySlug,
    dayOfMonth: parsed.dayOfMonth,
    active: parsed.active,
    notes: parsed.notes,
  };

  if (parsed.id) {
    await db
      .update(recurringTransactions)
      .set(values)
      .where(
        and(eq(recurringTransactions.userId, session.id), eq(recurringTransactions.id, parsed.id)),
      );
  } else {
    await db.insert(recurringTransactions).values(values);
  }

  revalidate();
}

export async function archiveRecurring(id: number) {
  const session = await getSessionUser();
  await db
    .update(recurringTransactions)
    .set({ deletedAt: sql`NOW()` })
    .where(
      and(
        eq(recurringTransactions.userId, session.id),
        eq(recurringTransactions.id, id),
        notDeleted(recurringTransactions.deletedAt),
      ),
    );
  revalidate();
}

export async function toggleRecurringActive(id: number, active: boolean) {
  const session = await getSessionUser();
  await db
    .update(recurringTransactions)
    .set({ active })
    .where(and(eq(recurringTransactions.userId, session.id), eq(recurringTransactions.id, id)));
  revalidate();
}

const dismissSchema = z.object({
  recurringId: z.coerce.number().int().positive(),
  ym: z.string().regex(/^\d{4}-\d{2}$/),
});

export async function dismissUpcoming(input: z.input<typeof dismissSchema>) {
  const session = await getSessionUser();
  const { recurringId, ym } = dismissSchema.parse(input);

  const result = await db.transaction(async (trx) => {
    const [row] = await trx
      .select({ skippedMonths: recurringTransactions.skippedMonths })
      .from(recurringTransactions)
      .where(
        and(
          eq(recurringTransactions.userId, session.id),
          eq(recurringTransactions.id, recurringId),
          notDeleted(recurringTransactions.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new Error("Recurring not found");
    const next = Array.from(new Set([...(row.skippedMonths ?? []), ym]));
    await trx
      .update(recurringTransactions)
      .set({ skippedMonths: next })
      .where(
        and(
          eq(recurringTransactions.userId, session.id),
          eq(recurringTransactions.id, recurringId),
        ),
      );

    const deleted = await trx
      .delete(recurringGaps)
      .where(
        and(
          eq(recurringGaps.userId, session.id),
          eq(recurringGaps.recurringId, recurringId),
          eq(recurringGaps.yearMonth, ym),
        ),
      )
      .returning({ id: recurringGaps.id });
    return { gapId: deleted[0]?.id ?? null };
  });

  emit({
    type: "recurring-gap:resolved",
    userId: session.id,
    gapId: result.gapId,
    reason: "skipped",
    timestamp: Date.now(),
  });

  revalidate();
}

export async function undismissUpcoming(input: z.input<typeof dismissSchema>) {
  const session = await getSessionUser();
  const { recurringId, ym } = dismissSchema.parse(input);
  const [row] = await db
    .select({ skippedMonths: recurringTransactions.skippedMonths })
    .from(recurringTransactions)
    .where(
      and(
        eq(recurringTransactions.userId, session.id),
        eq(recurringTransactions.id, recurringId),
        notDeleted(recurringTransactions.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new Error("Recurring not found");
  const next = (row.skippedMonths ?? []).filter((m) => m !== ym);
  await db
    .update(recurringTransactions)
    .set({ skippedMonths: next })
    .where(
      and(eq(recurringTransactions.userId, session.id), eq(recurringTransactions.id, recurringId)),
    );
  revalidate();
}

const paidExternalSchema = z.object({
  recurringId: z.coerce.number().int().positive(),
  yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
});

export type PaidExternalInput = z.input<typeof paidExternalSchema>;

/**
 * #1034: mark an occurrence as paid from an account findash deliberately does
 * not track (prod: Seguridad Social Aida/Alejo). This is NOT the same fact as
 * `skipped_months` ("this month did not happen") — it happened and was paid
 * elsewhere, so the slot is resolved while `resolution_tx_id` stays NULL: no
 * transaction exists and none will.
 *
 * Mirrors dismissUpcoming's shape (resolve the slot for one (recurring, month))
 * with the paid-external resolution instead of dropping the row. Idempotent:
 * re-marking an already-marked slot is a no-op, not a duplicate row.
 */
export async function markOccurrencePaidExternal(input: PaidExternalInput) {
  const session = await getSessionUser();
  const { recurringId, yearMonth: ym } = paidExternalSchema.parse(input);

  await db.transaction(async (trx) => {
    const [recurring] = await trx
      .select({ id: recurringTransactions.id })
      .from(recurringTransactions)
      .where(
        and(
          eq(recurringTransactions.userId, session.id),
          eq(recurringTransactions.id, recurringId),
          notDeleted(recurringTransactions.deletedAt),
        ),
      )
      .limit(1);
    if (!recurring) throw new Error("Recurring not found");

    // A real transaction already covering this month means the occurrence was
    // actually matched; "paid elsewhere" would contradict the link. Same shape
    // the fixed-id repair script refuses (S7).
    const [linked] = await trx
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, session.id),
          eq(transactions.recurringId, recurringId),
          eq(transactions.recurringYearMonth, ym),
          notDeleted(transactions.deletedAt),
        ),
      )
      .limit(1);
    if (linked) throw new Error(`Already covered this month by tx #${linked.id}`);

    // Idempotent: a slot already in this state is left exactly as it is (same
    // resolvedAt, no write) — the same early-return shape unlinkTxFromRecurring
    // uses.
    const [existing] = await trx
      .select({ resolution: recurringGaps.resolution })
      .from(recurringGaps)
      .where(
        and(
          eq(recurringGaps.userId, session.id),
          eq(recurringGaps.recurringId, recurringId),
          eq(recurringGaps.yearMonth, ym),
        ),
      )
      .limit(1);
    if (existing?.resolution === GAP_RESOLUTION_PAID_EXTERNAL) return;

    const resolvedAt = new Date();
    await trx
      .insert(recurringGaps)
      .values({
        userId: session.id,
        recurringId,
        yearMonth: ym,
        resolution: GAP_RESOLUTION_PAID_EXTERNAL,
        resolvedAt,
        resolutionTxId: null,
      })
      .onConflictDoUpdate({
        target: [recurringGaps.recurringId, recurringGaps.yearMonth],
        set: {
          resolution: GAP_RESOLUTION_PAID_EXTERNAL,
          resolvedAt,
          resolutionTxId: null,
        },
      });
  });

  revalidateSlots();
}

/**
 * #1034: undo a paid-external mark, returning the slot to open so the detector
 * treats the occurrence as uncovered again on its next run. Mirrors
 * unlinkTxFromRecurring: only a slot currently resolved with exactly this
 * resolution is reopened, any other resolution is left untouched, and a second
 * call is a no-op.
 */
export async function unmarkOccurrencePaidExternal(input: PaidExternalInput) {
  const session = await getSessionUser();
  const { recurringId, yearMonth: ym } = paidExternalSchema.parse(input);

  await db
    .update(recurringGaps)
    .set({ resolution: null, resolutionTxId: null, resolvedAt: null })
    .where(
      and(
        eq(recurringGaps.userId, session.id),
        eq(recurringGaps.recurringId, recurringId),
        eq(recurringGaps.yearMonth, ym),
        eq(recurringGaps.resolution, GAP_RESOLUTION_PAID_EXTERNAL),
      ),
    );

  revalidateSlots();
}

const promoteSchema = z.object({
  recurringId: z.coerce.number().int().positive(),
  yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountCents: z.union([z.bigint(), z.string().regex(/^-?\d+$/), z.number().int()]).optional(),
});

export type PromoteUpcomingInput = z.input<typeof promoteSchema>;

export async function promoteUpcoming(input: PromoteUpcomingInput) {
  const session = await getSessionUser();
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
    .where(
      and(
        eq(recurringTransactions.userId, session.id),
        eq(recurringTransactions.id, recurringId),
        notDeleted(recurringTransactions.deletedAt),
      ),
    )
    .limit(1);
  if (!r) throw new Error("Recurring not found");

  const [dup] = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, session.id),
        eq(transactions.recurringId, r.id),
        eq(transactions.recurringYearMonth, ym),
        notDeleted(transactions.deletedAt),
      ),
    )
    .limit(1);
  if (dup) throw new Error(`Already covered this month by tx #${dup.id}`);

  const signedCents =
    amountCents !== undefined ? toBigInt(amountCents, r.amountCents) : r.amountCents;

  const occurredAt = new Date(`${occurredOn}T12:00:00Z`);
  const cls = r.categorySlug ? null : await classifyByRule(session.id, { descriptionRaw: r.label });

  const result = await db.transaction(async (trx) => {
    const [inserted] = await trx
      .insert(transactions)
      .values({
        userId: session.id,
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
      .where(
        and(
          eq(recurringGaps.userId, session.id),
          eq(recurringGaps.recurringId, r.id),
          eq(recurringGaps.yearMonth, ym),
        ),
      )
      .returning({ id: recurringGaps.id });

    return { txId: inserted.id, gapId: deleted[0]?.id ?? null };
  });

  emit({
    type: "transaction:created",
    userId: session.id,
    id: result.txId,
    source: "recurring",
    timestamp: Date.now(),
  });

  if (result.gapId !== null) {
    emit({
      type: "recurring-gap:resolved",
      userId: session.id,
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
