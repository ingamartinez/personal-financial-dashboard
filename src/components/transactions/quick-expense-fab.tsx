import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, categories } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUserOrNull } from "@/lib/auth/session";
import { QuickEntryDialog } from "./quick-entry-dialog";

export async function QuickExpenseFab() {
  const session = await getSessionUserOrNull();
  if (!session) return null;

  const [accs, cats] = await Promise.all([
    db
      .select({ id: accounts.id, name: accounts.name, currency: accounts.currency })
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

  return <QuickEntryDialog accounts={accs} categories={cats} />;
}
