"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  accounts,
  categories,
  physicalCards,
  transactions,
  type AccountMetadata,
} from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { derivedBalanceCentsSql } from "@/lib/accounts/queries";
import { getSessionUser } from "@/lib/auth/session";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { convertCents } from "@/lib/money";

const ADJUSTMENT_CATEGORY_SLUG = "adjustments";

// #406/#411: each bucket is stored as "percent × 10000" so the schema can
// hold Bancolombia's 4-decimal display (e.g. "1.9110%" → 19110). The limits
// match `validateInstallmentRate` in src/lib/finance/rates.ts — same
// convention enforced at both layers.
const creditRateBucketsSchema = z
  .object({
    oneMonth: z
      .number()
      .int()
      .nonnegative()
      .refine((v) => v === 0 || v >= 5000, {
        message: "Tasa EM sospechosamente baja (¿EA mal etiquetada como EM?)",
      })
      .refine((v) => v < 1_000_000, { message: "Tasa EM fuera de rango razonable" }),
    months2to36: z
      .number()
      .int()
      .nonnegative()
      .refine((v) => v === 0 || v >= 5000, {
        message: "Tasa EM sospechosamente baja (¿EA mal etiquetada como EM?)",
      })
      .refine((v) => v < 1_000_000, { message: "Tasa EM fuera de rango razonable" }),
    advances: z
      .number()
      .int()
      .nonnegative()
      .refine((v) => v === 0 || v >= 5000, {
        message: "Tasa EM sospechosamente baja (¿EA mal etiquetada como EM?)",
      })
      .refine((v) => v < 1_000_000, { message: "Tasa EM fuera de rango razonable" }),
  })
  .strict();

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
    interestRateMonthly: z.number().nonnegative().optional(),
    termMonths: z.number().int().positive().optional(),
    loanOriginalCents: z.number().int().nonnegative().optional(),
    loanRemainingCents: z.number().int().nonnegative().optional(),
    monthlyPaymentCents: z.number().int().nonnegative().optional(),
    creditRateBuckets: creditRateBucketsSchema.optional(),
  })
  .strict();

const sideSchema = z.object({
  currency: z.enum(["COP", "USD"]),
  balance: z.coerce.number().finite(),
  metadata: metadataSchema.optional(),
});

// When creating a multi-currency credit card, the top-level `physicalCard`
// carries the shared-cupo attributes (#346). Replaces the old per-side
// `metadata.creditLimitCents` duplication. Optional — if omitted, the server
// falls back to `MAX(primary.metadata.creditLimitCents, secondary.metadata.creditLimitCents)`
// for backwards compat with the pre-Task-5 form payload.
const physicalCardInputSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    creditLimitCents: z.number().int().nonnegative().optional(),
    cutoffDay: z.number().int().min(1).max(31).optional(),
    last4: z
      .string()
      .regex(/^\d{4}$/)
      .optional(),
    network: z.enum(["visa", "mastercard", "amex"]).optional(),
  })
  .strict();

const upsertSchema = z
  .object({
    id: z.coerce.number().int().positive().optional(),
    name: z.string().min(1).max(100),
    institution: z.string().min(1).max(50),
    type: z.enum(["savings", "credit_card", "loan"]),
    active: z.coerce.boolean().default(true),
    primary: sideSchema,
    secondary: sideSchema.optional(),
    physicalCard: physicalCardInputSchema.optional(),
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
  })
  .refine((v) => !v.physicalCard || v.secondary, {
    message: "physicalCard requires a secondary side (multi-currency only)",
    path: ["physicalCard"],
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
    metadata: (side.metadata ?? {}) as AccountMetadata,
  };
}

/** Declared opening balance in cents — the ledger seed for a new account. */
function openingBalanceCents(side: z.infer<typeof sideSchema>): bigint {
  return BigInt(Math.round(side.balance * 100));
}

/**
 * #368: balance is derived from `SUM(transactions.amount_cents)`. On
 * account creation we persist the user-declared opening balance as an
 * adjustment-style transaction so the derived value matches what the
 * user typed. Stays a no-op when balance is 0. Callers must first
 * ensure the 'adjustments' category exists for the user.
 */
async function insertOpeningBalanceTx(
  trx: Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db,
  userId: number,
  accountId: number,
  currency: "COP" | "USD",
  balanceCents: bigint,
): Promise<void> {
  if (balanceCents === BigInt(0)) return;
  const today = new Date();
  await trx.insert(transactions).values({
    userId,
    accountId,
    occurredAt: today,
    amountCents: balanceCents,
    currency,
    descriptionRaw: "Saldo inicial",
    categorySlug: ADJUSTMENT_CATEGORY_SLUG,
    classificationMethod: "manual",
    source: "balance_adjustment",
    channel: "manual",
    isAdjustment: true,
    rawData: { event: "opening_balance", issue: 368 },
  });
}

async function ensureAdjustmentsCategory(
  trx: Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db,
  userId: number,
): Promise<void> {
  await trx
    .insert(categories)
    .values({
      userId,
      slug: ADJUSTMENT_CATEGORY_SLUG,
      name: "Ajustes de saldo",
      icon: "wrench",
      color: "#475569",
      sortOrder: 1000,
    })
    .onConflictDoNothing({ target: [categories.userId, categories.slug] });
  await trx
    .update(categories)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(and(eq(categories.userId, userId), eq(categories.slug, ADJUSTMENT_CATEGORY_SLUG)));
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
    // Multi-currency credit cards have a shared COP cupo owned by `physical_cards`
    // (#346). Insert the parent row first so the FK on accounts.physical_card_id
    // resolves within the same transaction.
    const physicalCardId = randomUUID();
    const primaryMeta = parsed.primary.metadata ?? {};
    const secondaryMeta = parsed.secondary.metadata ?? {};
    // Prefer the explicit top-level physicalCard payload (Task 5 form). Fall
    // back to MAX of per-side metadata for pre-Task-5 callers and tests.
    const creditLimitCents =
      parsed.physicalCard?.creditLimitCents ??
      Math.max(primaryMeta.creditLimitCents ?? 0, secondaryMeta.creditLimitCents ?? 0);
    const cutoffDay =
      parsed.physicalCard?.cutoffDay ?? primaryMeta.cutoffDay ?? secondaryMeta.cutoffDay;
    const network = parsed.physicalCard?.network ?? primaryMeta.network ?? secondaryMeta.network;
    const last4 =
      parsed.physicalCard?.last4 ?? primaryMeta.last4s?.[0] ?? secondaryMeta.last4s?.[0];
    const plasticName = parsed.physicalCard?.name ?? parsed.name;
    await db.transaction(async (trx) => {
      await trx.insert(physicalCards).values({
        id: physicalCardId,
        userId: session.id,
        institution: parsed.institution,
        name: plasticName,
        network,
        last4,
        creditLimitCents: BigInt(creditLimitCents),
        statementCutoffDay: cutoffDay,
      });
      const inserted = await trx
        .insert(accounts)
        .values([
          { ...base, ...sideToValues(parsed.primary), physicalCardId },
          { ...base, ...sideToValues(parsed.secondary!), physicalCardId },
        ])
        .returning({ id: accounts.id, currency: accounts.currency });
      await ensureAdjustmentsCategory(trx, session.id);
      const primaryInserted = inserted.find((r) => r.currency === parsed.primary.currency)!;
      const secondaryInserted = inserted.find((r) => r.currency === parsed.secondary!.currency)!;
      await insertOpeningBalanceTx(
        trx,
        session.id,
        primaryInserted.id,
        parsed.primary.currency,
        openingBalanceCents(parsed.primary),
      );
      await insertOpeningBalanceTx(
        trx,
        session.id,
        secondaryInserted.id,
        parsed.secondary!.currency,
        openingBalanceCents(parsed.secondary!),
      );
    });
  } else {
    await db.transaction(async (trx) => {
      const [inserted] = await trx
        .insert(accounts)
        .values({ ...base, ...sideToValues(parsed.primary) })
        .returning({ id: accounts.id });
      await ensureAdjustmentsCategory(trx, session.id);
      await insertOpeningBalanceTx(
        trx,
        session.id,
        inserted.id,
        parsed.primary.currency,
        openingBalanceCents(parsed.primary),
      );
    });
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

const updatePhysicalCardSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(100).nullable().optional(),
    creditLimitCents: z.coerce.number().int().nonnegative().optional(),
    statementCutoffDay: z.coerce.number().int().min(1).max(31).nullable().optional(),
    last4: z
      .string()
      .regex(/^\d{4}$/)
      .nullable()
      .optional(),
    network: z.enum(["visa", "mastercard", "amex"]).nullable().optional(),
  })
  .strict();

export type UpdatePhysicalCardInput = z.input<typeof updatePhysicalCardSchema>;

/**
 * Partially updates a physical card's shared attributes (#346, #362). Scoped by
 * `user_id = session.id`. Field semantics:
 * - `undefined` → field is not touched
 * - `null`      → field is cleared
 * - value       → field is set
 * This lets 🎫 (cupo+network only) and ✏️ (name/cutoff/last4) coexist without
 * trashing each other's state when either submits.
 */
export async function updatePhysicalCard(
  input: UpdatePhysicalCardInput,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const session = await getSessionUser();
  const parsed = updatePhysicalCardSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Input inválido." };
  }

  const d = parsed.data;
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (d.name !== undefined) set.name = d.name;
  if (d.creditLimitCents !== undefined) set.creditLimitCents = BigInt(d.creditLimitCents);
  if (d.statementCutoffDay !== undefined) set.statementCutoffDay = d.statementCutoffDay;
  if (d.last4 !== undefined) set.last4 = d.last4;
  if (d.network !== undefined) set.network = d.network;

  const result = await db
    .update(physicalCards)
    .set(set)
    .where(and(eq(physicalCards.id, d.id), eq(physicalCards.userId, session.id)))
    .returning({ id: physicalCards.id });

  if (result.length === 0) {
    return { ok: false, message: "Tarjeta física no encontrada." };
  }
  revalidate();
  return { ok: true };
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

const declaredSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("balance"),
    balanceCents: z.coerce.number().int(),
  }),
  z.object({
    kind: z.literal("availableCredit"),
    availableCreditCents: z.coerce.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("sharedAvailableCop"),
    // Cupo disponible COP del plástico según el banco. El server back-solves
    // la deuda del target a partir del sibling + TRM (#346 AS-4/AS-5).
    availableCopCents: z.coerce.number().int().nonnegative(),
  }),
]);

const adjustSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  declared: declaredSchema,
  reason: z.string().max(500).optional(),
});

export type AdjustBalanceInput = z.input<typeof adjustSchema>;

export type AdjustBalanceResult =
  | { status: "ok"; diffCents: string; txId: number }
  | { status: "noop" }
  | { status: "error"; message: string };

/**
 * Reconciliation balance adjustment (YNAB pattern). Inserts a transaction for
 * (target - current) into the account with `is_adjustment=true`, then updates
 * `accounts.balance_cents` to the target value. Both happen atomically.
 *
 * Two input shapes via `declared`:
 *
 * - `kind: "balance"` — direct balance_cents target. Used for savings and loan,
 *   where the bank app tells the user their balance literally.
 *
 * - `kind: "availableCredit"` — credit card cupo disponible. The bank app
 *   never shows debt directly, only the available limit, so the server
 *   reads `metadata.creditLimitCents` and derives
 *   `balance_cents = availableCreditCents - creditLimitCents` (negative, per
 *   the repo convention — see CreditMeter in /accounts). Also updates
 *   `metadata.availableCreditCents` so the card display stays consistent.
 *
 * The adjustment tx is categorized as `adjustments` — spend/insights queries
 * filter these out via `is_adjustment = false`; balance/net-worth queries
 * include them.
 */
export async function adjustAccountBalance(
  input: AdjustBalanceInput,
): Promise<AdjustBalanceResult> {
  const session = await getSessionUser();
  const parsed = adjustSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Input inválido." };
  }

  return db.transaction(async (tx) => {
    const [accountRow] = await tx
      .select({
        id: accounts.id,
        type: accounts.type,
        currency: accounts.currency,
        balanceCents: derivedBalanceCentsSql,
        metadata: accounts.metadata,
        physicalCardId: accounts.physicalCardId,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, session.id),
          eq(accounts.id, parsed.data.accountId),
          notDeleted(accounts.deletedAt),
        ),
      );

    if (!accountRow) {
      return { status: "error", message: "Cuenta no encontrada." };
    }
    const account = { ...accountRow, balanceCents: BigInt(accountRow.balanceCents) };

    let targetBalanceCents: bigint;
    let nextMetadata: AccountMetadata = account.metadata;

    if (parsed.data.declared.kind === "balance") {
      targetBalanceCents = BigInt(parsed.data.declared.balanceCents);
    } else if (parsed.data.declared.kind === "availableCredit") {
      if (account.type !== "credit_card") {
        return {
          status: "error",
          message: "El cupo disponible solo aplica a tarjetas de crédito.",
        };
      }
      // Multi-currency cards (#346) use sharedAvailableCop — the per-currency
      // availableCredit path would only mutate half the pair and leave the
      // shared cupo inconsistent. Force clients onto the new path.
      if (account.physicalCardId) {
        return {
          status: "error",
          message:
            "Esta tarjeta es multi-moneda. Usá el flujo de cupo compartido (COP) para ajustar.",
        };
      }
      const limit = account.metadata.creditLimitCents;
      if (limit === undefined || limit <= 0) {
        return {
          status: "error",
          message: "La tarjeta no tiene límite de crédito configurado. Editala primero.",
        };
      }
      const available = parsed.data.declared.availableCreditCents;
      if (available > limit) {
        return {
          status: "error",
          message: "El cupo disponible no puede superar al límite de la tarjeta.",
        };
      }
      // debt is limit - available; balance_cents for credit_card is stored
      // negative (debt reduces net worth — see CreditMeter).
      targetBalanceCents = BigInt(available) - BigInt(limit);
      nextMetadata = { ...account.metadata, availableCreditCents: available };
    } else {
      // kind: "sharedAvailableCop" (#346). Back-solve the target sub-account's
      // balance from: the shared cupo, the declared-available-COP, the sibling
      // sub-accounts' balances, and the current TRM.
      if (account.type !== "credit_card" || !account.physicalCardId) {
        return {
          status: "error",
          message: "El cupo compartido solo aplica a tarjetas multi-moneda.",
        };
      }
      const [pc] = await tx
        .select({
          id: physicalCards.id,
          creditLimitCents: physicalCards.creditLimitCents,
        })
        .from(physicalCards)
        .where(
          and(eq(physicalCards.id, account.physicalCardId), eq(physicalCards.userId, session.id)),
        );
      if (!pc || pc.creditLimitCents <= BigInt(0)) {
        return {
          status: "error",
          message:
            "El plástico no tiene cupo configurado. Editá la tarjeta física y cargá el cupo primero.",
        };
      }
      const availableCopCents = BigInt(parsed.data.declared.availableCopCents);
      if (availableCopCents > pc.creditLimitCents) {
        return {
          status: "error",
          message: "El cupo disponible no puede superar al cupo total del plástico.",
        };
      }
      const siblingRows = await tx
        .select({
          id: accounts.id,
          currency: accounts.currency,
          balanceCents: derivedBalanceCentsSql,
        })
        .from(accounts)
        .where(
          and(
            eq(accounts.userId, session.id),
            eq(accounts.physicalCardId, account.physicalCardId),
            sql`${accounts.id} != ${account.id}`,
            notDeleted(accounts.deletedAt),
          ),
        );
      const siblings = siblingRows.map((s) => ({ ...s, balanceCents: BigInt(s.balanceCents) }));

      const fx = await getCurrentFxRate();
      // Total debt (COP) across the pair = limit - declared available.
      const totalDebtCop = pc.creditLimitCents - availableCopCents;
      // Sibling debt expressed in COP. Balances are negative, so we negate.
      let siblingDebtCop = BigInt(0);
      for (const sib of siblings) {
        const sibDebtNative = sib.balanceCents < BigInt(0) ? -sib.balanceCents : BigInt(0);
        siblingDebtCop += convertCents(sibDebtNative, sib.currency, "COP", fx.rate);
      }
      // Remainder is what the target sub-account must carry as debt.
      const targetDebtCop = totalDebtCop - siblingDebtCop;
      // Convert COP-denominated target debt to the target's native currency.
      const targetDebtNative =
        targetDebtCop <= BigInt(0)
          ? BigInt(0)
          : convertCents(targetDebtCop, "COP", account.currency, fx.rate);
      targetBalanceCents = -targetDebtNative;
      // Strip metadata.availableCreditCents if present — single source of truth
      // lives in physical_cards.credit_limit_cents + sub-account balances.
      if (account.metadata.availableCreditCents !== undefined) {
        const { availableCreditCents: _drop, ...rest } = account.metadata;
        void _drop;
        nextMetadata = rest;
      }
    }

    const diff = targetBalanceCents - account.balanceCents;

    if (diff === BigInt(0)) {
      // Metadata might still need to be persisted even when the balance
      // didn't move (e.g. first time availableCreditCents is stored).
      const metadataDrifted =
        parsed.data.declared.kind === "availableCredit" &&
        account.metadata.availableCreditCents !== parsed.data.declared.availableCreditCents;
      if (metadataDrifted) {
        await tx
          .update(accounts)
          .set({ metadata: nextMetadata, updatedAt: new Date() })
          .where(eq(accounts.id, account.id));
        revalidate();
      }
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
          declared: parsed.data.declared,
          declaredBalanceCents: targetBalanceCents.toString(),
          previousBalanceCents: account.balanceCents.toString(),
        },
      })
      .returning({ id: transactions.id });

    // Balance is derived from SUM(transactions.amount_cents) post #368 —
    // the adjustment tx inserted above *is* the state change. Metadata
    // still needs persisting (availableCreditCents, etc.).
    await tx
      .update(accounts)
      .set({ metadata: nextMetadata, updatedAt: today })
      .where(eq(accounts.id, account.id));

    revalidate();
    return { status: "ok", diffCents: diff.toString(), txId: inserted.id };
  });
}
