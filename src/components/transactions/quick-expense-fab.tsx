import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, categories } from "@/lib/db/schema";
import { QuickExpenseDialog } from "./quick-expense-dialog";

export async function QuickExpenseFab() {
  const [accs, cats] = await Promise.all([
    db
      .select({ id: accounts.id, name: accounts.name, currency: accounts.currency })
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
  ]);

  return <QuickExpenseDialog accounts={accs} categories={cats} />;
}
