import { aliasedTable, and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { budgets, categories, transactions } from "@/lib/db/schema";
import { notAdjustment, notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import { BudgetsManager } from "./budgets-manager";

export const dynamic = "force-dynamic";

function currentYearMonth(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function monthRange(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0, 23, 59, 59));
  return {
    start,
    end,
    startIso: `${ym}-01`,
    endIso: `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`,
  };
}

export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string }>;
}) {
  const session = await getSessionUser();
  const params = await searchParams;
  const ym = params.ym && /^\d{4}-\d{2}$/.test(params.ym) ? params.ym : currentYearMonth();
  const { start, end, startIso } = monthRange(ym);

  const [cats, rows, spentRows] = await Promise.all([
    db
      .select({
        slug: categories.slug,
        name: categories.name,
        parentSlug: categories.parentSlug,
      })
      .from(categories)
      .where(and(eq(categories.userId, session.id), notDeleted(categories.deletedAt)))
      .orderBy(asc(categories.sortOrder), asc(categories.name)),
    db
      .select({
        id: budgets.id,
        categorySlug: budgets.categorySlug,
        categoryName: categories.name,
        amountCents: budgets.amountCents,
        currency: budgets.currency,
        periodStart: budgets.periodStart,
        periodEnd: budgets.periodEnd,
      })
      .from(budgets)
      .leftJoin(categories, eq(categories.slug, budgets.categorySlug))
      .where(and(eq(budgets.periodStart, startIso), notDeleted(budgets.deletedAt)))
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
        .leftJoin(txCategory, eq(txCategory.slug, transactions.categorySlug))
        .where(
          and(
            gte(transactions.occurredAt, start),
            lte(transactions.occurredAt, end),
            notAdjustment(transactions.isAdjustment),
          ),
        )
        .groupBy(rootSlug);
    })(),
  ]);

  const spentMap = new Map<string, bigint>();
  for (const s of spentRows) {
    if (s.rootSlug) spentMap.set(s.rootSlug, BigInt(s.spentCents));
  }

  const items = rows.map((r) => ({
    id: r.id,
    categorySlug: r.categorySlug,
    categoryName: r.categoryName ?? r.categorySlug,
    amountCents: r.amountCents.toString(),
    spentCents: (spentMap.get(r.categorySlug) ?? BigInt(0)).toString(),
    currency: r.currency,
  }));

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Budgets</h1>
        <p className="text-body text-muted-foreground">
          Monthly spending caps per category. Each month starts fresh — no rollover. Progress tracks
          expenses (negative transactions) in the selected month.
        </p>
      </header>
      <BudgetsManager ym={ym} categories={cats} items={items} />
    </main>
  );
}
