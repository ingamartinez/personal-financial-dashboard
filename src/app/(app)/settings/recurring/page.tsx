import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, categories, recurringTransactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import { RecurringManager } from "./recurring-manager";

export const dynamic = "force-dynamic";

export default async function RecurringPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; account?: string; activeOnly?: string }>;
}) {
  const session = await getSessionUser();
  const {
    category: rawCategory,
    account: rawAccount,
    activeOnly: rawActiveOnly,
  } = await searchParams;

  const [accs, cats] = await Promise.all([
    db
      .select({
        id: accounts.id,
        name: accounts.name,
        currency: accounts.currency,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, session.id),
          eq(accounts.active, true),
          notDeleted(accounts.deletedAt),
        ),
      )
      .orderBy(asc(accounts.name)),
    db
      .select({
        slug: categories.slug,
        name: categories.name,
        parentSlug: categories.parentSlug,
      })
      .from(categories)
      .where(and(eq(categories.userId, session.id), notDeleted(categories.deletedAt)))
      .orderBy(asc(categories.sortOrder), asc(categories.name)),
  ]);

  // Validate filter params against the user's own rows (tenant safety). Never
  // put a raw searchParam into the where clause.
  const validSlugs = new Set(cats.map((c) => c.slug));
  const activeCategory = rawCategory && validSlugs.has(rawCategory) ? rawCategory : null;

  const parsedAccountId = Number(rawAccount);
  const validAccountIds = new Set(accs.map((a) => a.id));
  const activeAccount =
    Number.isInteger(parsedAccountId) && validAccountIds.has(parsedAccountId)
      ? parsedAccountId
      : null;

  const activeOnly = rawActiveOnly === "true";

  const recurringWhere = and(
    eq(recurringTransactions.userId, session.id),
    notDeleted(recurringTransactions.deletedAt),
    activeCategory ? eq(recurringTransactions.categorySlug, activeCategory) : undefined,
    activeAccount !== null ? eq(recurringTransactions.accountId, activeAccount) : undefined,
    activeOnly ? eq(recurringTransactions.active, true) : undefined,
  );

  const items = await db
    .select({
      id: recurringTransactions.id,
      accountId: recurringTransactions.accountId,
      accountName: accounts.name,
      label: recurringTransactions.label,
      amountCents: recurringTransactions.amountCents,
      currency: recurringTransactions.currency,
      categorySlug: recurringTransactions.categorySlug,
      dayOfMonth: recurringTransactions.dayOfMonth,
      active: recurringTransactions.active,
      notes: recurringTransactions.notes,
    })
    .from(recurringTransactions)
    .innerJoin(accounts, eq(accounts.id, recurringTransactions.accountId))
    .where(recurringWhere)
    .orderBy(asc(recurringTransactions.dayOfMonth));

  const rows = items.map((r) => ({
    ...r,
    amountCents: r.amountCents.toString(),
  }));

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Recurring forecast</h1>
        <p className="text-body text-muted-foreground">
          Declare expected monthly items (rent, loan, subscriptions). These are FORECASTS — not real
          transactions. They appear as &ldquo;upcoming&rdquo; on the dashboard and auto-match when
          the real tx lands.
        </p>
      </header>
      <RecurringManager
        accounts={accs}
        categories={cats}
        items={rows}
        activeCategory={activeCategory}
        activeAccount={activeAccount}
        activeOnly={activeOnly}
      />
    </main>
  );
}
