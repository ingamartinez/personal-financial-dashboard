import { aliasedTable, and, asc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { budgets, categories, transactions } from "@/lib/db/schema";
import { notAdjustment, notDeleted, notInternalMovement } from "@/lib/db/helpers";
import type { Currency } from "@/lib/types";
import type { DisplayCurrencyMode } from "@/lib/db/schema";
import { convertCents, displayCurrencyFor } from "@/lib/money";
import {
  pickBucket,
  sumByGroupAndDisplayCurrency,
  type AggregationBucket,
} from "@/lib/fx/aggregate";

export type BudgetCategory = {
  slug: string;
  name: string;
  parentSlug: string | null;
};

export type BudgetOverviewItem = {
  id: number;
  categorySlug: string;
  categoryName: string;
  /**
   * Amount the user budgeted, in `currency`. In `all-cop` / `all-usd` modes
   * this is converted from the budget's native currency using LIVE TRM
   * (budget plans are forward-looking targets — no frozen TRM exists for them).
   */
  amountCents: string;
  /**
   * Spend in `currency`, computed per-row using each tx's FROZEN TRM
   * (`rawData.fx.trmToAccountCurrency`). Converting before summing keeps
   * historical accuracy — a 2024 USD purchase contributes its 2024 COP
   * equivalent, not today's TRM × USD.
   */
  spentCents: string;
  /**
   * Display currency for both `amountCents` and `spentCents`. In native mode
   * this matches the budget's plan currency. In all-X modes this matches the
   * mode target (COP or USD).
   */
  currency: Currency;
  /**
   * #527: true when at least one tx in this category was converted via
   * frozen TRM. Drives the "convertido con TRM histórica" tooltip.
   */
  hadFrozenTrmConversion: boolean;
  /**
   * #527: number of txs in this category whose conversion was needed but
   * the frozen TRM was missing. Surfaces data-quality gaps without breaking
   * the total — those rows still contribute at their native value.
   */
  missingTrmCount: number;
};

export type BudgetsOverview = {
  categories: BudgetCategory[];
  items: BudgetOverviewItem[];
};

function defaultCalendarRange(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  return { start, end };
}

/**
 * Budget plans are anchored on calendar months (`budgets.periodStart` matches
 * `${ym}-01`). Spend aggregation, however, can run over a different range so
 * pay-period users see consistent numbers across the dashboard and budgets
 * page. Pass `spendRange` resolved from `getFinancialPeriod` at the call
 * site; omit it to fall back to the calendar month implied by `yearMonth`.
 *
 * #527: aggregation is now per-row using `convertToDisplayCurrency` so each
 * USD/USDc tx contributes its frozen-TRM equivalent — not today's rate.
 *  - `displayCurrencyMode='native'`: spent stays in budget currency, only
 *    same-currency txs contribute (cross-currency spend is suppressed by
 *    `pickBucket` and surfaced as a non-zero `missingTrmCount` indirectly).
 *  - `'all-cop'` / `'all-usd'`: every tx is converted to the target via its
 *    own frozen TRM; budget amounts are converted via LIVE TRM (`copPerUsd`)
 *    since plans are forward-looking and have no frozen rate.
 */
export async function getBudgetsOverview(
  userId: number,
  yearMonth: string,
  spendRange?: { start: Date; end: Date },
  fxOpts?: { displayCurrencyMode: DisplayCurrencyMode; copPerUsd: number },
): Promise<BudgetsOverview> {
  const startIso = `${yearMonth}-01`;
  const { start, end } = spendRange ?? defaultCalendarRange(yearMonth);
  const mode: DisplayCurrencyMode = fxOpts?.displayCurrencyMode ?? "native";
  const copPerUsd = fxOpts?.copPerUsd ?? 0;

  const [cats, rows, txRows] = await Promise.all([
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
          amountCents: transactions.amountCents,
          currency: transactions.currency,
          // Project rawData the same way as listTransactions (#528): only `fx`
          // and `merged_statement.fx` cross the boundary. `convertToDisplayCurrency`
          // → `extractFxMetadataWithFallback` reads exactly these two paths.
          rawData: sql<Record<string, unknown> | null>`CASE
            WHEN ${transactions.rawData} IS NULL THEN NULL
            ELSE jsonb_build_object(
              'fx', ${transactions.rawData} -> 'fx',
              'merged_statement', jsonb_build_object(
                'fx', ${transactions.rawData} -> 'merged_statement' -> 'fx'
              )
            )
          END`.as("raw_data"),
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
            lt(transactions.occurredAt, end),
            notInternalMovement(transactions.channel),
            notAdjustment(transactions.isAdjustment),
            notDeleted(transactions.deletedAt),
            sql`${transactions.amountCents} < 0`,
          ),
        );
    })(),
  ]);

  // Per-row aggregation in the user's display currency. Rows with rootSlug=null
  // (no category) are dropped — same semantics as the previous SQL GROUP BY.
  // We sum ABSOLUTE expense (negate the amountCents) so callers consume a
  // non-negative spent value, matching the legacy contract.
  const positiveRows = txRows.map((r) => ({
    rootSlug: r.rootSlug,
    amountCents: -r.amountCents,
    currency: r.currency,
    rawData: r.rawData,
  }));
  const grouped = sumByGroupAndDisplayCurrency(positiveRows, mode, (r) => r.rootSlug);

  const items: BudgetOverviewItem[] = rows.map((r) => {
    const buckets = grouped.get(r.categorySlug) ?? [];
    const targetCurrency: Currency =
      mode === "native" ? r.currency : displayCurrencyFor(mode, r.currency);

    const matched = pickBucket(buckets, targetCurrency);

    // Sum missingTrmCount across ALL buckets for this category (any tx that
    // needed conversion but had no TRM is a data-quality flag, regardless of
    // which bucket it ended up in).
    const missingTrmCount = buckets.reduce(
      (acc: number, b: AggregationBucket) => acc + b.missingTrmCount,
      0,
    );
    const hadFrozenTrmConversion = buckets.some((b) => b.convertedCount > 0);

    // Convert budget amount via LIVE TRM in all-X modes — plans have no
    // frozen rate. Native mode is a passthrough.
    const budgetAmountCents =
      mode === "native"
        ? r.amountCents
        : convertCents(r.amountCents, r.currency, targetCurrency, copPerUsd);

    return {
      id: r.id,
      categorySlug: r.categorySlug,
      categoryName: r.categoryName ?? r.categorySlug,
      amountCents: budgetAmountCents.toString(),
      spentCents: matched.cents.toString(),
      currency: targetCurrency,
      hadFrozenTrmConversion,
      missingTrmCount,
    };
  });

  return { categories: cats, items };
}
