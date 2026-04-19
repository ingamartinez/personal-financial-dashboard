import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { InboxIcon } from "lucide-react";
import { db } from "@/lib/db";
import { accounts, ingestionLogs } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import { EmptyState } from "@/components/ui/empty-state";
import { InboxTable, type InboxAccountOption, type InboxRow } from "./inbox-table";

export const dynamic = "force-dynamic";

export default async function SettingsInboxPage() {
  const session = await getSessionUser();

  const [logRows, accountRows] = await Promise.all([
    db
      .select({
        id: ingestionLogs.id,
        source: ingestionLogs.source,
        errorMessage: ingestionLogs.errorMessage,
        payload: ingestionLogs.payload,
        startedAt: ingestionLogs.startedAt,
      })
      .from(ingestionLogs)
      .where(
        and(
          eq(ingestionLogs.userId, session.id),
          eq(ingestionLogs.status, "error"),
          isNull(ingestionLogs.resolvedAt),
        ),
      )
      .orderBy(desc(ingestionLogs.startedAt))
      .limit(200),
    db
      .select({
        id: accounts.id,
        name: accounts.name,
        institution: accounts.institution,
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
      .orderBy(asc(accounts.institution), asc(accounts.name)),
  ]);

  const rows: InboxRow[] = logRows.map((r) => ({
    id: r.id,
    source: r.source,
    errorMessage: r.errorMessage,
    payload: r.payload,
    startedAt: r.startedAt.toISOString(),
  }));

  const accountOptions: InboxAccountOption[] = accountRows.map((a) => ({
    id: a.id,
    label: `${a.institution} · ${a.name} (${a.currency})`,
    currency: a.currency,
  }));

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Ingestion inbox</h1>
        <p className="text-body text-muted-foreground">
          SMS o ingests que fallaron y quedaron sin crear transacción. Revisalos uno por uno:
          reintentalos con la cuenta correcta o descartalos. El raw payload se conserva para
          auditoría aunque descartes.
        </p>
      </header>
      {rows.length === 0 ? (
        <EmptyState
          icon={<InboxIcon />}
          title="Todo en orden"
          description="No hay errores de ingesta pendientes. Cuando llegue un SMS que no podamos rutear, aparecerá acá."
        />
      ) : (
        <InboxTable rows={rows} accountOptions={accountOptions} />
      )}
    </main>
  );
}
