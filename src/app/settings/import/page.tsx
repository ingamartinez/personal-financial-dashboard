import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { ImportForm } from "./import-form";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const accs = await db
    .select({ id: accounts.id, name: accounts.name, currency: accounts.currency })
    .from(accounts)
    .where(eq(accounts.active, true))
    .orderBy(asc(accounts.name));

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Import</h1>
        <p className="text-sm text-muted-foreground">
          Bulk-import transactions from a bank export.
        </p>
      </header>
      <ImportForm accounts={accs} />
    </main>
  );
}
