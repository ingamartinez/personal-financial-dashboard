"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { accounts, categories, transactions, type AccountMetadata } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";

const ADJUSTMENT_CATEGORY_SLUG = "adjustments";

const metadataSchema = z
  .object({
    last4s: z
      .array(z.string().regex(/^\d{4}$/))
      .max(8)
      .optional(),
    network: z.enum(["visa", "mastercard", "amex"]).optional(),
    creditLimitCents: z.number().int().nonnegative().optional(),
    availableCreditCents: z.number().int().nonnegative().optional(),
    cutoffDay: z.number().int().min(1).max(31).optional(),
    paymentDueDay: z.number().int().min(1).max(31).optional(),
    interestRateMonthly: z.number().nonnegative().optional(),
    termMonths: z.number().int().positive().optional(),
    loanOriginalCents: z.number().int().nonnegative().optional(),
    loanRemainingCents: z.number().int().nonnegative().optional(),
    monthlyPaymentCents: z.number().int().nonnegative().optional(),
  })
  .strict();

const sideSchema = z.object({
  currency: z.enum(["COP", "USD"]),
  balance: z.coerce.number().finite(),
  metadata: metadataSchema.optional(),
});

const upsertSchema = z
  .object({
    id: z.coerce.number().int().positive().optional(),
    name: z.string().min(1).max(100),
    institution: z.string().min(1).max(50),
    type: z.enum(["savings", "credit_card", "loan"]),
    active: z.coerce.boolean().default(true),
    primary: sideSchema,
    secondary: sideSchema.optional(),
  })
  .refine((v) => !v.secondary || v.type === "credit_card", {
    message: "Multi-currency only supported for credit_card",
    path: ["secondary"],
  })
  .refine((v) => !v.secondary || v.secondary.currency !== v.primary.currency, {
    message: "Secondary currency must differ from primary",
    path: ["secondary", "currency"],
  })
  .refine((v) => !v.secondary || !v.id, {
    message: "Multi-currency can only be set on create",
    path: ["secondary"],
  });

export type AccountUpsertInput = z.input<typeof upsertSchema>;

function revalidate() {
  revalidatePath("/");
  revalidatePath("/accounts");
  revalidatePath("/settings/accounts");
}

function sideToValues(side: z.infer<typeof sideSchema>) {
  return {
    currency: side.currency,
    balanceCents: BigInt(Math.round(side.balance * 100)),
    metadata: (side.metadata ?? {}) as AccountMetadata,
  };
}

export async function upsertAccount(input: AccountUpsertInput) {
  const session = await getSessionUser();
  const parsed = upsertSchema.parse(input);

  const base = {
    userId: session.id,
    name: parsed.name,
    institution: parsed.institution,
    type: parsed.type,
    active: parsed.active,
    updatedAt: new Date(),
  };

  if (parsed.id) {
    const primaryValues = sideToValues(parsed.primary);
    await db
      .update(accounts)
      .set({ ...base, ...primaryValues })
      .where(
        and(
          eq(accounts.userId, session.id),
          eq(accounts.id, parsed.id),
          notDeleted(accounts.deletedAt),
        ),
      );
    revalidate();
    return;
  }

  if (parsed.secondary) {
    const physicalCardId = randomUUID();
    await db.transaction(async (trx) => {
      await trx.insert(accounts).values([
        { ...base, ...sideToValues(parsed.primary), physicalCardId },
        { ...base, ...sideToValues(parsed.secondary!), physicalCardId },
      ]);
    });
  } else {
    await db.insert(accounts).values({ ...base, ...sideToValues(parsed.primary) });
  }

  revalidate();
}

export async function archiveAccount(id: number) {
  const session = await getSessionUser();
  const parsedId = z.coerce.number().int().positive().parse(id);
  await db
    .update(accounts)
    .set({ deletedAt: sql`NOW()`, updatedAt: new Date() })
    .where(
      and(
        eq(accounts.userId, session.id),
        eq(accounts.id, parsedId),
        notDeleted(accounts.deletedAt),
      ),
    );
  revalidate();
}

export async function toggleAccountActive(id: number, active: boolean) {
  const session = await getSessionUser();
  const parsedId = z.coerce.number().int().positive().parse(id);
  await db
    .update(accounts)
    .set({ active, updatedAt: new Date() })
    .where(
      and(
        eq(accounts.userId, session.id),
        eq(accounts.id, parsedId),
        notDeleted(accounts.deletedAt),
      ),
    );
  revalidate();
}

const adjustSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  declaredBalanceCents: z.coerce.number().int(),
  reason: z.string().max(500).optional(),
});

export type AdjustBalanceResult =
  | { status: "ok"; diffCents: string; txId: number }
  | { status: "noop" }
  | { status: "error"; message: string };

/**
 * Reconciliation balance adjustment (YNAB pattern). Inserts a transaction for
 * (declared - current) into the account with `is_adjustment=true`, then
 * updates `accounts.balance_cents` to the declared value. Both happen atomically.
 *
 * The adjustment tx is categorized as `adjustments` — spend/insights queries
 * filter these out via `is_adjustment = false`; balance/net-worth queries
 * include them.
 */
export async function adjustAccountBalance(
  input: z.input<typeof adjustSchema>,
): Promise<AdjustBalanceResult> {
  const session = await getSessionUser();
  const parsed = adjustSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Input inválido." };
  }

  return db.transaction(async (tx) => {
    const [account] = await tx
      .select({
        id: accounts.id,
        currency: accounts.currency,
        balanceCents: accounts.balanceCents,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, session.id),
          eq(accounts.id, parsed.data.accountId),
          notDeleted(accounts.deletedAt),
        ),
      );

    if (!account) {
      return { status: "error", message: "Cuenta no encontrada." };
    }

    const declared = BigInt(parsed.data.declaredBalanceCents);
    const diff = declared - account.balanceCents;

    if (diff === BigInt(0)) {
      return { status: "noop" };
    }

    // Ensure the per-user "adjustments" category exists — self-heal for users
    // that signed up before the seed was added (or archived it by mistake).
    await tx
      .insert(categories)
      .values({
        userId: session.id,
        slug: ADJUSTMENT_CATEGORY_SLUG,
        name: "Ajustes de saldo",
        icon: "wrench",
        color: "#475569",
        sortOrder: 1000,
      })
      .onConflictDoNothing({ target: [categories.userId, categories.slug] });

    // Undo soft-delete if the user archived this category previously.
    await tx
      .update(categories)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(and(eq(categories.userId, session.id), eq(categories.slug, ADJUSTMENT_CATEGORY_SLUG)));

    const today = new Date();
    const ymd = today.toISOString().slice(0, 10);

    const [inserted] = await tx
      .insert(transactions)
      .values({
        userId: session.id,
        accountId: account.id,
        occurredAt: today,
        amountCents: diff,
        currency: account.currency,
        descriptionRaw: `Ajuste de saldo (declarado ${ymd})`,
        categorySlug: ADJUSTMENT_CATEGORY_SLUG,
        classificationMethod: "manual",
        source: "balance_adjustment",
        channel: "manual",
        isAdjustment: true,
        rawData: {
          reason: parsed.data.reason ?? null,
          declaredBalanceCents: declared.toString(),
          previousBalanceCents: account.balanceCents.toString(),
        },
      })
      .returning({ id: transactions.id });

    await tx
      .update(accounts)
      .set({ balanceCents: declared, updatedAt: today })
      .where(eq(accounts.id, account.id));

    revalidate();
    return { status: "ok", diffCents: diff.toString(), txId: inserted.id };
  });
}
