import { asc } from "drizzle-orm";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import { AccountsManager, type AccountRow } from "./accounts-manager";

export const dynamic = "force-dynamic";

export default async function SettingsAccountsPage() {
  const session = await getSessionUser();
  const rows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      institution: accounts.institution,
      type: accounts.type,
      currency: accounts.currency,
      balanceCents: accounts.balanceCents,
      active: accounts.active,
      metadata: accounts.metadata,
      physicalCardId: accounts.physicalCardId,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, session.id), notDeleted(accounts.deletedAt)))
    .orderBy(asc(accounts.type), asc(accounts.name));

  const items: AccountRow[] = rows.map((r) => ({
    ...r,
    balanceCents: r.balanceCents.toString(),
  }));

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Accounts</h1>
        <p className="text-body text-muted-foreground">
          Create and manage your savings accounts, credit cards, and loans. These are the buckets
          that your transactions are associated with.
        </p>
      </header>
      <AccountsManager items={items} />
    </main>
  );
}
