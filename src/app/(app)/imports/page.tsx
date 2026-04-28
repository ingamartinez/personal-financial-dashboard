// /imports page — Phase 2 unified upload entry point.
//
// Reads hint_account_id and hint_cycle from searchParams (deep-link hints from
// reconcile / consolidate pages). Validates hint_account_id ownership before
// passing to the uploader. Non-owned hints are silently ignored (AC-19).
//
// Next.js 16: searchParams MUST be awaited.
// Memory: nextjs16-use-server-async-only

import Link from "next/link";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import { createLogger } from "@/lib/logger";
import { hintSchema } from "./_dispatch-ui-types";
import { StatementUploader } from "@/components/imports/statement-uploader";

const log = createLogger({ module: "imports-page" });

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Importar extracto — Findash",
};

export default async function ImportsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSessionUser();
  const rawParams = (await searchParams) ?? {};

  // Flatten arrays to first value for simple scalar params
  const flatParams = Object.fromEntries(
    Object.entries(rawParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
  );

  // Parse hint params — on validation failure, ignore silently
  const hintParse = hintSchema.safeParse({
    hint_account_id: flatParams.hint_account_id,
    hint_cycle: flatParams.hint_cycle,
  });
  const hints = hintParse.success ? hintParse.data : {};

  // Validate hint_account_id ownership server-side before pre-filling (AC-19)
  let validatedHintAccountId: number | undefined;
  if (hints.hint_account_id) {
    const [hintAccount] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, session.id),
          eq(accounts.id, hints.hint_account_id),
          notDeleted(accounts.deletedAt),
        ),
      )
      .limit(1);
    if (hintAccount) {
      validatedHintAccountId = hintAccount.id;
    } else {
      log.info(
        {
          event: "account_hint_not_owned",
          hintedAccountId: hints.hint_account_id,
          userId: session.id,
        },
        "hint_account_id not owned by session user — ignoring",
      );
    }
  }

  // Load non-deleted accounts for the dropdown
  const userAccounts = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      currency: accounts.currency,
      institution: accounts.institution,
      metadata: accounts.metadata,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, session.id), notDeleted(accounts.deletedAt)));

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Importar extracto</h1>
        <p className="text-body text-muted-foreground mt-1">
          Subí un extracto ARQ (PDF) o Bancolombia (XLSX). El sistema detecta el formato
          automáticamente y reconcilia las transacciones.
        </p>
        {validatedHintAccountId && (
          <p className="text-muted-foreground mt-2 text-xs">
            Cuenta pre-seleccionada desde tu extracto.{" "}
            <Link href="/imports" className="underline underline-offset-2">
              Limpiar
            </Link>
          </p>
        )}
      </header>

      <StatementUploader
        accounts={userAccounts}
        initialHint={{
          accountId: validatedHintAccountId,
          cycle: hints.hint_cycle,
        }}
      />
    </main>
  );
}
