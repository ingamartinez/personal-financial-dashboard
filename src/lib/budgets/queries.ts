import { aliasedTable, and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { budgets, categories, transactions } from "@/lib/db/schema";
import { notAdjustment, notDeleted } from "@/lib/db/helpers";
import type { Currency } from "@/lib/types";

export type BudgetCategory = {
  slug: string;
  name: string;
  parentSlug: string | null;
};

export type BudgetOverviewItem = {
  id: number;
  categorySlug: string;
  categoryName: string;
  amountCents: string;
  spentCents: string;
  currency: Currency;
};

export type BudgetsOverview = {
  categories: BudgetCategory[];
  items: BudgetOverviewItem[];
};

function monthRange(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0, 23, 59, 59));
  return { start, end, startIso: `${ym}-01` };
}

export async function getBudgetsOverview(
  userId: number,
  yearMonth: string,
): Promise<BudgetsOverview> {
  const { start, end, startIso } = monthRange(yearMonth);

  const [cats, rows, spentRows] = await Promise.all([
    db
      .select({
        slug: categories.slug,
        name: categories.name,
        parentSlug: categories.parentSlug,
      })
      .from(categories)
      .where(and(eq(categories.userId, userId), notDeleted(categories.deletedAt)))
      .orderBy(asc(categories.sortOrder), asc(categories.name)),
    db
      .select({
        id: budgets.id,
        categorySlug: budgets.categorySlug,
        categoryName: categories.name,
        amountCents: budgets.amountCents,
        currency: budgets.currency,
      })
      .from(budgets)
      .leftJoin(
        categories,
        and(eq(categories.slug, budgets.categorySlug), eq(categories.userId, budgets.userId)),
      )
      .where(
        and(
          eq(budgets.userId, userId),
          eq(budgets.periodStart, startIso),
          notDeleted(budgets.deletedAt),
        ),
      )
      .orderBy(asc(categories.sortOrder), asc(categories.name)),
    (() => {
      const txCategory = aliasedTable(categories, "tx_category");
      const rootSlug = sql<string | null>`COALESCE(${txCategory.parentSlug}, ${txCategory.slug})`;
      return db
        .select({
          rootSlug,
          spentCents: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.amountCents} < 0 THEN -${transactions.amountCents} ELSE 0 END), 0)`,
        })
        .from(transactions)
        .leftJoin(
          txCategory,
          and(
            eq(txCategory.slug, transactions.categorySlug),
            eq(txCategory.userId, transactions.userId),
          ),
        )
        .where(
          and(
            eq(transactions.userId, userId),
            gte(transactions.occurredAt, start),
            lte(transactions.occurredAt, end),
            notAdjustment(transactions.isAdjustment),
            notDeleted(transactions.deletedAt),
          ),
        )
        .groupBy(rootSlug);
    })(),
  ]);

  const spentMap = new Map<string, bigint>();
  for (const s of spentRows) {
    if (s.rootSlug) spentMap.set(s.rootSlug, BigInt(s.spentCents));
  }

  const items: BudgetOverviewItem[] = rows.map((r) => ({
    id: r.id,
    categorySlug: r.categorySlug,
    categoryName: r.categoryName ?? r.categorySlug,
    amountCents: r.amountCents.toString(),
    spentCents: (spentMap.get(r.categorySlug) ?? BigInt(0)).toString(),
    currency: r.currency,
  }));

  return { categories: cats, items };
}
