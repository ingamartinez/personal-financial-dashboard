"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, ilike, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { categories, classificationRules, ruleProposals, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";

const patternSchema = z.string().trim().min(1).max(200);
const categorySlugSchema = z.string().min(1).max(60);
const prioritySchema = z.number().int().min(1).max(10000);

const createSchema = z.object({
  pattern: patternSchema,
  categorySlug: categorySlugSchema,
  priority: prioritySchema.default(100),
});

const updateSchema = z.object({
  id: z.number().int().positive(),
  pattern: patternSchema,
  categorySlug: categorySlugSchema,
  priority: prioritySchema,
});

const idSchema = z.object({ id: z.number().int().positive() });
const toggleSchema = z.object({ id: z.number().int().positive(), active: z.boolean() });

export type RulePreviewSample = {
  id: number;
  merchant: string | null;
  descriptionClean: string | null;
  currentCategorySlug: string;
  amountCents: string;
  occurredAt: string;
};

export type RulePreview = {
  matchCount: number;
  sample: RulePreviewSample[];
};

export type RuleActionResult = { status: "ok" } | { status: "error"; message: string };

export type RuleCreateResult =
  | { status: "ok"; ruleId: number; preview: RulePreview }
  | { status: "error"; message: string };

export type RuleApplyResult =
  | { status: "ok"; updatedCount: number }
  | { status: "error"; message: string };

function isUniqueViolation(err: unknown, constraintName: string): boolean {
  if (!err || typeof err !== "object") return false;
  const message = err instanceof Error ? err.message : "";
  if (message.includes(constraintName)) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const code = (cause as { code?: unknown }).code;
    const name = (cause as { constraint_name?: unknown }).constraint_name;
    if (code === "23505" && name === constraintName) return true;
  }
  return false;
}

async function assertCategoryExists(userId: number, slug: string): Promise<boolean> {
  const [row] = await db
    .select({ slug: categories.slug })
    .from(categories)
    .where(
      and(
        eq(categories.userId, userId),
        eq(categories.slug, slug),
        notDeleted(categories.deletedAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Dry-run for retroactive rule application. Counts and samples transactions
 * from the last 90 days that match the pattern (ILIKE on description_clean or
 * merchant) and have a DIFFERENT current category. Unclassified rows are
 * excluded — they'll be picked up by the regular classifier on next pass.
 */
async function previewRuleApply(
  userId: number,
  pattern: string,
  categorySlug: string,
): Promise<RulePreview> {
  const baseCondition = and(
    eq(transactions.userId, userId),
    sql`${transactions.occurredAt} > now() - interval '90 days'`,
    or(ilike(transactions.descriptionClean, pattern), ilike(transactions.merchant, pattern)),
    isNotNull(transactions.categorySlug),
    sql`${transactions.categorySlug} <> ${categorySlug}`,
    notDeleted(transactions.deletedAt),
  )!;

  const [countRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(transactions)
    .where(baseCondition);

  const sample = await db
    .select({
      id: transactions.id,
      merchant: transactions.merchant,
      descriptionClean: transactions.descriptionClean,
      currentCategorySlug: transactions.categorySlug,
      amountCents: transactions.amountCents,
      occurredAt: transactions.occurredAt,
    })
    .from(transactions)
    .where(baseCondition)
    .orderBy(desc(transactions.occurredAt))
    .limit(5);

  return {
    matchCount: countRow?.n ?? 0,
    sample: sample.map((r) => ({
      id: r.id,
      merchant: r.merchant,
      descriptionClean: r.descriptionClean,
      // Non-null by virtue of isNotNull filter above — the type guard doesn't
      // propagate through drizzle's select, so coerce here.
      currentCategorySlug: r.currentCategorySlug as string,
      amountCents: r.amountCents.toString(),
      occurredAt: r.occurredAt.toISOString(),
    })),
  };
}

export async function createRule(input: z.input<typeof createSchema>): Promise<RuleCreateResult> {
  const session = await getSessionUser();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Input inválido." };
  }

  if (!(await assertCategoryExists(session.id, parsed.data.categorySlug))) {
    return { status: "error", message: "La categoría no existe o está archivada." };
  }

  let ruleId: number;
  try {
    const [inserted] = await db
      .insert(classificationRules)
      .values({
        userId: session.id,
        pattern: parsed.data.pattern,
        categorySlug: parsed.data.categorySlug,
        priority: parsed.data.priority,
        active: true,
        autoGenerated: false,
      })
      .returning({ id: classificationRules.id });
    ruleId = inserted.id;
  } catch (err) {
    if (isUniqueViolation(err, "rules_user_pattern_category_unique")) {
      return { status: "error", message: "Ya tenés una regla con ese patrón y categoría." };
    }
    throw err;
  }

  const preview = await previewRuleApply(session.id, parsed.data.pattern, parsed.data.categorySlug);

  revalidatePath("/settings/rules");
  return { status: "ok", ruleId, preview };
}

export async function updateRule(input: z.input<typeof updateSchema>): Promise<RuleActionResult> {
  const session = await getSessionUser();
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Input inválido." };
  }

  if (!(await assertCategoryExists(session.id, parsed.data.categorySlug))) {
    return { status: "error", message: "La categoría no existe o está archivada." };
  }

  try {
    const result = await db
      .update(classificationRules)
      .set({
        pattern: parsed.data.pattern,
        categorySlug: parsed.data.categorySlug,
        priority: parsed.data.priority,
      })
      .where(
        and(eq(classificationRules.userId, session.id), eq(classificationRules.id, parsed.data.id)),
      )
      .returning({ id: classificationRules.id });

    if (result.length === 0) {
      return { status: "error", message: "Regla no encontrada." };
    }
  } catch (err) {
    if (isUniqueViolation(err, "rules_user_pattern_category_unique")) {
      return { status: "error", message: "Ya tenés una regla con ese patrón y categoría." };
    }
    throw err;
  }

  revalidatePath("/settings/rules");
  return { status: "ok" };
}

export async function toggleRuleActive(
  input: z.input<typeof toggleSchema>,
): Promise<RuleActionResult> {
  const session = await getSessionUser();
  const parsed = toggleSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: "Input inválido." };
  }

  const result = await db
    .update(classificationRules)
    .set({ active: parsed.data.active })
    .where(
      and(eq(classificationRules.userId, session.id), eq(classificationRules.id, parsed.data.id)),
    )
    .returning({ id: classificationRules.id });

  if (result.length === 0) {
    return { status: "error", message: "Regla no encontrada." };
  }

  revalidatePath("/settings/rules");
  return { status: "ok" };
}

export async function deleteRule(input: z.input<typeof idSchema>): Promise<RuleActionResult> {
  const session = await getSessionUser();
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: "Input inválido." };
  }

  // Hard delete — rules are cheap to recreate and `copyRuleSeedsToUser` can
  // re-seed baseline rules if needed. If an auto-generated rule is deleted,
  // the learning loop in #317 will be free to re-propose it after 30 days.
  // FK on transactions.retroactive_rule_id is ON DELETE SET NULL so historical
  // retroactive applications survive (previous_category_slug is preserved).
  const result = await db
    .delete(classificationRules)
    .where(
      and(eq(classificationRules.userId, session.id), eq(classificationRules.id, parsed.data.id)),
    )
    .returning({ id: classificationRules.id });

  if (result.length === 0) {
    return { status: "error", message: "Regla no encontrada." };
  }

  revalidatePath("/settings/rules");
  return { status: "ok" };
}

export async function approveRuleProposal(
  input: z.input<typeof idSchema>,
): Promise<RuleCreateResult> {
  const session = await getSessionUser();
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: "Input inválido." };
  }

  let ruleId: number;
  let pattern: string;
  let categorySlug: string;
  try {
    const result = await db.transaction(async (trx) => {
      const [proposal] = await trx
        .select({
          id: ruleProposals.id,
          merchant: ruleProposals.merchant,
          categorySlug: ruleProposals.categorySlug,
          correctionTxnIds: ruleProposals.correctionTxnIds,
          status: ruleProposals.status,
        })
        .from(ruleProposals)
        .where(and(eq(ruleProposals.userId, session.id), eq(ruleProposals.id, parsed.data.id)))
        .limit(1)
        .for("update");

      if (!proposal) throw new ProposalNotFoundError();
      if (proposal.status !== "pending") throw new ProposalAlreadyDecidedError();

      // Merchant wrapped in ILIKE wildcards. If merchant contains a literal %
      // the user can edit the rule after the fact; default keeps the common
      // case trivial.
      const pattern = `%${proposal.merchant}%`;

      const [inserted] = await trx
        .insert(classificationRules)
        .values({
          userId: session.id,
          pattern,
          categorySlug: proposal.categorySlug,
          priority: 100,
          active: true,
          autoGenerated: true,
          generatedFromCorrections: proposal.correctionTxnIds,
        })
        .returning({ id: classificationRules.id });

      await trx
        .update(ruleProposals)
        .set({ status: "approved", decidedAt: new Date() })
        .where(eq(ruleProposals.id, proposal.id));

      return { ruleId: inserted.id, pattern, categorySlug: proposal.categorySlug };
    });
    ruleId = result.ruleId;
    pattern = result.pattern;
    categorySlug = result.categorySlug;
  } catch (err) {
    if (err instanceof ProposalNotFoundError) {
      return { status: "error", message: "Propuesta no encontrada." };
    }
    if (err instanceof ProposalAlreadyDecidedError) {
      return { status: "error", message: "Esa propuesta ya fue decidida." };
    }
    if (isUniqueViolation(err, "rules_user_pattern_category_unique")) {
      return {
        status: "error",
        message: "Ya existe una regla con ese patrón y categoría — editala o elimínala primero.",
      };
    }
    throw err;
  }

  const preview = await previewRuleApply(session.id, pattern, categorySlug);

  revalidatePath("/settings/rules");
  return { status: "ok", ruleId, preview };
}

export async function denyRuleProposal(input: z.input<typeof idSchema>): Promise<RuleActionResult> {
  const session = await getSessionUser();
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: "Input inválido." };
  }

  const result = await db
    .update(ruleProposals)
    .set({ status: "denied", decidedAt: new Date() })
    .where(
      and(
        eq(ruleProposals.userId, session.id),
        eq(ruleProposals.id, parsed.data.id),
        eq(ruleProposals.status, "pending"),
      ),
    )
    .returning({ id: ruleProposals.id });

  if (result.length === 0) {
    return { status: "error", message: "Propuesta no encontrada o ya decidida." };
  }

  revalidatePath("/settings/rules");
  return { status: "ok" };
}

class ProposalNotFoundError extends Error {}
class ProposalAlreadyDecidedError extends Error {}

export async function downgradeAutoGeneratedRule(
  input: z.input<typeof idSchema>,
): Promise<RuleActionResult> {
  const session = await getSessionUser();
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: "Input inválido." };
  }

  const result = await db
    .update(classificationRules)
    .set({ autoGenerated: false, generatedFromCorrections: null })
    .where(
      and(
        eq(classificationRules.userId, session.id),
        eq(classificationRules.id, parsed.data.id),
        eq(classificationRules.autoGenerated, true),
      ),
    )
    .returning({ id: classificationRules.id });

  if (result.length === 0) {
    return { status: "error", message: "Regla no encontrada o no es auto-generada." };
  }

  revalidatePath("/settings/rules");
  return { status: "ok" };
}

/**
 * Retroactively applies a rule to the last 90 days of transactions. Stamps
 * `previous_category_slug` so the action can be reverted by revertRuleRetroactive.
 * Idempotent: re-running is a no-op because the WHERE guards already-applied rows.
 */
export async function applyRuleRetroactive(
  input: z.input<typeof idSchema>,
): Promise<RuleApplyResult> {
  const session = await getSessionUser();
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: "Input inválido." };
  }

  const [rule] = await db
    .select({
      id: classificationRules.id,
      pattern: classificationRules.pattern,
      categorySlug: classificationRules.categorySlug,
    })
    .from(classificationRules)
    .where(
      and(eq(classificationRules.userId, session.id), eq(classificationRules.id, parsed.data.id)),
    )
    .limit(1);

  if (!rule) {
    return { status: "error", message: "Regla no encontrada." };
  }

  const result = await db.execute<{ id: number }>(sql`
    UPDATE transactions
    SET
      previous_category_slug = category_slug,
      category_slug = ${rule.categorySlug},
      classification_method = 'rule_retroactive',
      classification_confidence = 100,
      retroactive_rule_id = ${rule.id},
      updated_at = now()
    WHERE user_id = ${session.id}
      AND occurred_at > now() - interval '90 days'
      AND (description_clean ILIKE ${rule.pattern} OR merchant ILIKE ${rule.pattern})
      AND category_slug IS NOT NULL
      AND category_slug <> ${rule.categorySlug}
    RETURNING id
  `);

  const updatedCount = result.length;

  revalidatePath("/settings/rules");
  revalidatePath("/transactions");
  return { status: "ok", updatedCount };
}

/**
 * Reverts a retroactive application. Restores each affected transaction to its
 * previous category and downgrades `classification_method` to `manual` (the
 * pre-retroactive method isn't stored; manual is the safest neutral).
 */
export async function revertRuleRetroactive(
  input: z.input<typeof idSchema>,
): Promise<RuleApplyResult> {
  const session = await getSessionUser();
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: "Input inválido." };
  }

  const [rule] = await db
    .select({ id: classificationRules.id })
    .from(classificationRules)
    .where(
      and(eq(classificationRules.userId, session.id), eq(classificationRules.id, parsed.data.id)),
    )
    .limit(1);

  if (!rule) {
    return { status: "error", message: "Regla no encontrada." };
  }

  const result = await db.execute<{ id: number }>(sql`
    UPDATE transactions
    SET
      category_slug = previous_category_slug,
      previous_category_slug = NULL,
      classification_method = 'manual',
      classification_confidence = 100,
      retroactive_rule_id = NULL,
      updated_at = now()
    WHERE user_id = ${session.id}
      AND retroactive_rule_id = ${rule.id}
      AND classification_method = 'rule_retroactive'
    RETURNING id
  `);

  const updatedCount = result.length;

  revalidatePath("/settings/rules");
  revalidatePath("/transactions");
  return { status: "ok", updatedCount };
}
