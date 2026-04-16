import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, categories, recurringTransactions } from "@/lib/db/schema";
import { RecurringManager } from "./recurring-manager";

export const dynamic = "force-dynamic";

export default async function RecurringPage() {
  const [accs, cats, items] = await Promise.all([
    db
      .select({
        id: accounts.id,
        name: accounts.name,
        currency: accounts.currency,
      })
      .from(accounts)
      .where(eq(accounts.active, true))
      .orderBy(asc(accounts.name)),
    db
      .select({
        slug: categories.slug,
        name: categories.name,
        parentSlug: categories.parentSlug,
      })
      .from(categories)
      .orderBy(asc(categories.sortOrder), asc(categories.name)),
    db
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
      .orderBy(asc(recurringTransactions.dayOfMonth)),
  ]);

  const rows = items.map((r) => ({
    ...r,
    amountCents: r.amountCents.toString(),
  }));

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Recurring forecast</h1>
        <p className="text-body text-muted-foreground">
          Declare expected monthly items (rent, loan, subscriptions). These are
          FORECASTS — not real transactions. They appear as &ldquo;upcoming&rdquo;
          on the dashboard and auto-match when the real tx lands.
        </p>
      </header>
      <RecurringManager accounts={accs} categories={cats} items={rows} />
    </main>
  );
}
