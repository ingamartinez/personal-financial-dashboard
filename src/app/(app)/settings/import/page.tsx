import Link from "next/link";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { ScreenshotUpload } from "@/components/import/screenshot-upload";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const accs = await db
    .select({ id: accounts.id, name: accounts.name, currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.active, true), notDeleted(accounts.deletedAt)))
    .orderBy(asc(accounts.name));

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Import</h1>
        <p className="text-body text-muted-foreground">
          OCR from screenshots. For Bancolombia XLSX statements, use the per-account{" "}
          <Link href="/settings/accounts" className="underline underline-offset-2">
            Reconcile
          </Link>{" "}
          flow — it reconciles against the bank statement instead of fire-and-forget importing.
        </p>
      </header>
      <ScreenshotUpload accounts={accs} />
    </main>
  );
}
