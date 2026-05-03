"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  accounts,
  categories,
  institutionSlug as institutionSlugEnum,
  physicalCards,
  transactions,
  type AccountMetadata,
} from "@/lib/db/schema";
import { INSTITUTION_LABELS } from "@/lib/accounts/format";
import { notDeleted } from "@/lib/db/helpers";
import { derivedBalanceCentsSql } from "@/lib/accounts/queries";
import { getSessionUser } from "@/lib/auth/session";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { convertCents } from "@/lib/money";
import type {
  AccountUpsertInput,
  AdjustBalanceInput,
  AdjustBalanceResult,
  UpdatePhysicalCardInput,
  UpsertAccountResult,
} from "./actions-types";
export type {
  AccountUpsertInput,
  AdjustBalanceInput,
  AdjustBalanceResult,
  UpdatePhysicalCardInput,
  UpsertAccountResult,
} from "./actions-types";

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

// The enum values exported by drizzle are the string literals from the pgEnum.
const INSTITUTION_SLUG_VALUES = institutionSlugEnum.enumValues;

const upsertSchema = z
  .object({
    id: z.coerce.number().int().positive().optional(),
    name: z.string().min(1).max(100),
    // `institutionSlug` is the canonical value bound to the Select. `institution`
    // is derived from it on the server and is no longer sent from the form.
    institutionSlug: z.enum(INSTITUTION_SLUG_VALUES),
    // Legacy free-text `institution` is kept optional for backward-compat with
    // any caller that pre-dates this issue — the server ignores it when
    // `institutionSlug` is present (always true for new form submissions).
    institution: z.string().min(1).max(50).optional(),
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

export async function upsertAccount(input: AccountUpsertInput): Promise<UpsertAccountResult> {
  const session = await getSessionUser();
  const parsed = upsertSchema.parse(input);

  // Derive human-readable institution from the slug. This is the single
  // source of truth — the form no longer sends a free-text `institution`.
  const institutionLabel = INSTITUTION_LABELS[parsed.institutionSlug] ?? parsed.institutionSlug;

  const base = {
    userId: session.id,
    name: parsed.name,
    institution: institutionLabel,
    institutionSlug: parsed.institutionSlug,
    type: parsed.type,
    active: parsed.active,
    updatedAt: new Date(),
  };

  if (parsed.id) {
    const accountId = parsed.id; // narrow out undefined for TS
    const primaryValues = sideToValues(parsed.primary);

    // Fetch the current account to check for physical_card_id (propagation).
    const [current] = await db
      .select({ physicalCardId: accounts.physicalCardId })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, session.id),
          eq(accounts.id, accountId),
          notDeleted(accounts.deletedAt),
        ),
      );

    let propagatedToSiblings = 0;

    await db.transaction(async (trx) => {
      // 1. Update the target account.
      await trx
        .update(accounts)
        .set({ ...base, ...primaryValues })
        .where(
          and(
            eq(accounts.userId, session.id),
            eq(accounts.id, accountId),
            notDeleted(accounts.deletedAt),
          ),
        );

      // 2. If the account belongs to a physical card, propagate institution to
      //    sibling legs — tenant-guarded (userId must match).
      if (current?.physicalCardId) {
        const updated = await trx
          .update(accounts)
          .set({
            institution: institutionLabel,
            institutionSlug: parsed.institutionSlug,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(accounts.userId, session.id),
              eq(accounts.physicalCardId, current.physicalCardId),
              ne(accounts.id, accountId),
              notDeleted(accounts.deletedAt),
            ),
          )
          .returning({ id: accounts.id });
        propagatedToSiblings = updated.length;

        // Also update the physical_cards row so its institution_slug stays in sync.
        await trx
          .update(physicalCards)
          .set({
            institution: institutionLabel,
            institutionSlug: parsed.institutionSlug,
            updatedAt: new Date(),
          })
          .where(
            and(eq(physicalCards.id, current.physicalCardId), eq(physicalCards.userId, session.id)),
          );
      }
    });

    revalidate();
    return { ok: true, propagatedToSiblings };
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
        institution: institutionLabel,
        institutionSlug: parsed.institutionSlug,
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
  return { ok: true as const, propagatedToSiblings: 0 };
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
  // #447 — dual-debt snapshot for shared-cupo multi-currency TCs. User enters
  // per-currency debts (the numbers the bank app displays) and the server
  // applies one balance_adjustment per sub-account atomically. No back-solve,
  // no TRM, no dependency on the sibling's ledger — drift in one side never
  // propagates to the other.
  //
  // Both fields are optional BUT at least one must be present: lets the user
  // adjust only the side that changed this cycle (e.g. USD updated by the
  // bank while COP is still on-ledger). Any undefined side keeps its current
  // balance untouched.
  z
    .object({
      kind: z.literal("perCurrencyDualDebt"),
      // Positive cents in native currency — e.g. 403_119_800 for "COP $4.031.198,00"
      // and 288_500 for "USD $2.885,00" as shown in the Bancolombia app.
      debtCopCents: z.coerce.number().int().nonnegative().optional(),
      debtUsdCents: z.coerce.number().int().nonnegative().optional(),
    })
    .refine((v) => v.debtCopCents !== undefined || v.debtUsdCents !== undefined, {
      message: "Entrá al menos una de las dos deudas (COP o USD).",
    }),
]);

const adjustSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  declared: declaredSchema,
  reason: z.string().max(500).optional(),
});

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
 *   the repo convention — see CreditMeter in /accounts). #420: the cupo is
 *   NOT snapshotted in metadata — display derives on read from limit +
 *   SUM(ledger), so the only persisted state change is the adjustment tx.
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

    // #447 — dual-debt is the only kind that applies changes to BOTH
    // sub-accounts of a shared-cupo plastic atomically, so it branches OUT of
    // the single-target flow below and returns directly.
    if (parsed.data.declared.kind === "perCurrencyDualDebt") {
      if (account.type !== "credit_card" || !account.physicalCardId) {
        return {
          status: "error",
          message: "Las deudas por moneda solo aplican a tarjetas multi-moneda.",
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
      // Load BOTH sibling sub-accounts (including the target itself — simpler
      // than conditional branching on which one the user opened the dialog
      // from). Validate we have exactly one COP + one USD, otherwise reject.
      const plasticRows = await tx
        .select({
          id: accounts.id,
          currency: accounts.currency,
          balanceCents: derivedBalanceCentsSql,
          metadata: accounts.metadata,
        })
        .from(accounts)
        .where(
          and(
            eq(accounts.userId, session.id),
            eq(accounts.physicalCardId, account.physicalCardId),
            notDeleted(accounts.deletedAt),
          ),
        );
      const copRow = plasticRows.find((r) => r.currency === "COP");
      const usdRow = plasticRows.find((r) => r.currency === "USD");
      if (!copRow || !usdRow || plasticRows.length !== 2) {
        return {
          status: "error",
          message:
            "El plástico necesita exactamente una sub-cuenta COP y una USD para usar este flujo.",
        };
      }

      // #447 — either side can be omitted (schema enforces at least one). A
      // missing side means "don't touch this sub-account" — we keep its
      // current ledger and only sanity-check against that baseline.
      const declaredCop =
        parsed.data.declared.debtCopCents !== undefined
          ? BigInt(parsed.data.declared.debtCopCents)
          : null;
      const declaredUsd =
        parsed.data.declared.debtUsdCents !== undefined
          ? BigInt(parsed.data.declared.debtUsdCents)
          : null;
      const currentDebtCop = (() => {
        const b = BigInt(copRow.balanceCents);
        return b < BigInt(0) ? -b : BigInt(0);
      })();
      const currentDebtUsd = (() => {
        const b = BigInt(usdRow.balanceCents);
        return b < BigInt(0) ? -b : BigInt(0);
      })();

      // Sanity check against the shared cupo: use the declared value where
      // provided, current ledger where not. This protects from one-sided
      // updates that would silently push total debt above the plastic's
      // limit. Only the TRM step lives in this check — individual targets
      // are stored in native currency so TRM drift never taints them.
      const fx = await getCurrentFxRate();
      const effectiveCop = declaredCop ?? currentDebtCop;
      const effectiveUsd = declaredUsd ?? currentDebtUsd;
      const debtUsdInCop = convertCents(effectiveUsd, "USD", "COP", fx.rate);
      if (effectiveCop + debtUsdInCop > pc.creditLimitCents) {
        return {
          status: "error",
          message:
            "La suma de deudas (COP + USD × TRM) supera el cupo total del plástico. Revisá los números.",
        };
      }

      // Ensure adjustments category once (self-heal same as single-target path).
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
      await tx
        .update(categories)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(
          and(eq(categories.userId, session.id), eq(categories.slug, ADJUSTMENT_CATEGORY_SLUG)),
        );

      const today = new Date();
      const ymd = today.toISOString().slice(0, 10);
      const results: Array<{
        accountId: number;
        currency: "COP" | "USD";
        diffCents: string;
        txId: number;
      }> = [];

      for (const sub of [copRow, usdRow] as const) {
        const declared = sub.currency === "COP" ? declaredCop : declaredUsd;
        // Skip the side the user didn't declare — the schema guarantees at
        // least one is present, so the other side's ledger stays untouched.
        if (declared === null) continue;
        const currentBalance = BigInt(sub.balanceCents);
        const targetBalance = -declared;
        const diff = targetBalance - currentBalance;
        if (diff === BigInt(0)) continue;
        const [inserted] = await tx
          .insert(transactions)
          .values({
            userId: session.id,
            accountId: sub.id,
            occurredAt: today,
            amountCents: diff,
            currency: sub.currency,
            descriptionRaw: `Ajuste de saldo (deuda declarada ${ymd})`,
            categorySlug: ADJUSTMENT_CATEGORY_SLUG,
            classificationMethod: "manual",
            source: "balance_adjustment",
            channel: "manual",
            isAdjustment: true,
            rawData: {
              reason: parsed.data.reason ?? null,
              declared: parsed.data.declared,
              declaredBalanceCents: targetBalance.toString(),
              previousBalanceCents: currentBalance.toString(),
            },
          })
          .returning({ id: transactions.id });
        results.push({
          accountId: sub.id,
          currency: sub.currency,
          diffCents: diff.toString(),
          txId: inserted.id,
        });
        // Strip stale `availableCreditCents` snapshot if present on this
        // sub-account's metadata (same convergence pattern as other kinds).
        if (sub.metadata?.availableCreditCents !== undefined) {
          const { availableCreditCents: _drop, ...rest } = sub.metadata;
          void _drop;
          await tx
            .update(accounts)
            .set({ metadata: rest, updatedAt: today })
            .where(eq(accounts.id, sub.id));
        }
      }

      if (results.length === 0) {
        revalidate();
        return { status: "noop" };
      }
      revalidate();
      return { status: "ok_dual", results };
    }

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
      // #420: stop snapshotting availableCreditCents. Display always derives
      // from limit + ledger; strip any stale value so old rows converge on
      // the next adjust (same pattern as sharedAvailableCop below).
      if (account.metadata.availableCreditCents !== undefined) {
        const { availableCreditCents: _drop, ...rest } = account.metadata;
        void _drop;
        nextMetadata = rest;
      }
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
      // #420: on no-op, still persist metadata if we stripped a stale
      // `availableCreditCents` snapshot. `nextMetadata !== account.metadata`
      // is the strip signal — both kinds (availableCredit, sharedAvailableCop)
      // rebind nextMetadata only when something needs cleaning up.
      if (nextMetadata !== account.metadata) {
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
    // the adjustment tx inserted above *is* the state change. This update
    // persists any `nextMetadata` rebind (currently only strip cleanups, #420).
    await tx
      .update(accounts)
      .set({ metadata: nextMetadata, updatedAt: today })
      .where(eq(accounts.id, account.id));

    revalidate();
    return { status: "ok", diffCents: diff.toString(), txId: inserted.id };
  });
}
