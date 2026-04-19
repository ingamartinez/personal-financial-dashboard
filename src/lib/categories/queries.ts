import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  budgets,
  categories,
  classificationRules,
  counterparties,
  recurringTransactions,
  transactions,
} from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";

export type CategoryRow = {
  id: number;
  slug: string;
  name: string;
  parentSlug: string | null;
  icon: string | null;
  color: string | null;
  sortOrder: number;
  createdAt: string;
  deletedAt: string | null;
};

export async function listUserCategories(userId: number): Promise<CategoryRow[]> {
  const rows = await db
    .select({
      id: categories.id,
      slug: categories.slug,
      name: categories.name,
      parentSlug: categories.parentSlug,
      icon: categories.icon,
      color: categories.color,
      sortOrder: categories.sortOrder,
      createdAt: categories.createdAt,
      deletedAt: categories.deletedAt,
    })
    .from(categories)
    .where(and(eq(categories.userId, userId), notDeleted(categories.deletedAt)))
    .orderBy(asc(categories.sortOrder), asc(categories.name));

  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
  }));
}

export type CategoryUsage = {
  transactions: number;
  budgets: number;
  classificationRules: number;
  counterparties: number;
  recurringTransactions: number;
  children: number;
};

/**
 * Count live references to a category (user-scoped). Used by archive actions
 * to block destructive operations when a category is in use.
 */
export async function countCategoryReferences(
  userId: number,
  slug: string,
): Promise<CategoryUsage> {
  const [txCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.categorySlug, slug)));

  const [budgetCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(budgets)
    .where(
      and(
        eq(budgets.userId, userId),
        eq(budgets.categorySlug, slug),
        notDeleted(budgets.deletedAt),
      ),
    );

  const [ruleCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(classificationRules)
    .where(and(eq(classificationRules.userId, userId), eq(classificationRules.categorySlug, slug)));

  const [counterpartyCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(counterparties)
    .where(and(eq(counterparties.userId, userId), eq(counterparties.defaultCategorySlug, slug)));

  const [recurringCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(recurringTransactions)
    .where(
      and(
        eq(recurringTransactions.userId, userId),
        eq(recurringTransactions.categorySlug, slug),
        notDeleted(recurringTransactions.deletedAt),
      ),
    );

  const [childCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(categories)
    .where(
      and(
        eq(categories.userId, userId),
        eq(categories.parentSlug, slug),
        notDeleted(categories.deletedAt),
      ),
    );

  return {
    transactions: txCount.n,
    budgets: budgetCount.n,
    classificationRules: ruleCount.n,
    counterparties: counterpartyCount.n,
    recurringTransactions: recurringCount.n,
    children: childCount.n,
  };
}

/**
 * Slug-to-name map for one user, used to render category labels on other
 * pages without re-querying per row. Omits archived.
 */
export async function categoryDisplayMap(userId: number): Promise<Map<string, string>> {
  const rows = await db
    .select({ slug: categories.slug, name: categories.name })
    .from(categories)
    .where(and(eq(categories.userId, userId), notDeleted(categories.deletedAt)));
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.slug, row.name);
  return map;
}

/** Returns true if (userId, slug) exists and is not archived. */
export async function categoryExists(userId: number, slug: string): Promise<boolean> {
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
  return !!row;
}
