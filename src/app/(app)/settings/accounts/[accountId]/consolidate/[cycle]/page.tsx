import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { accounts, statementImports } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import { formatAccountLabel } from "@/lib/accounts/format";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";

import type { ConsolidationReport } from "@/lib/ingestion/bancolombia-statement/consolidate";
import { ConsolidateForm } from "./consolidate-form";
import { ReportSection } from "./consolidate-report-view";

export const dynamic = "force-dynamic";

function formatBogotaDate(d: Date): string {
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "America/Bogota",
  }).format(d);
}

type CycleRouteParams = Promise<{ accountId: string; cycle: string }>;
type CycleRouteSearchParams = Promise<{ view?: string | string[] }>;

export default async function ConsolidatePage({
  params,
  searchParams,
}: {
  params: CycleRouteParams;
  searchParams?: CycleRouteSearchParams;
}) {
  const session = await getSessionUser();
  const { accountId: rawId, cycle } = await params;
  const search = (await searchParams) ?? {};
  const rawView = Array.isArray(search.view) ? search.view[0] : search.view;
  const view = rawView === "run" ? "run" : "summary";
  const accountId = Number(rawId);
  if (!Number.isInteger(accountId) || accountId <= 0) notFound();
  if (!/^\d{4}-\d{2}$/.test(cycle)) notFound();

  const [account] = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      institution: accounts.institution,
      institutionSlug: accounts.institutionSlug,
      currency: accounts.currency,
      type: accounts.type,
      metadata: accounts.metadata,
      deletedAt: accounts.deletedAt,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, session.id),
        eq(accounts.id, accountId),
        notDeleted(accounts.deletedAt),
      ),
    )
    .limit(1);
  if (!account) notFound();

  const [existing] = await db
    .select({
      id: statementImports.id,
      importedAt: statementImports.importedAt,
      syntheticTxId: statementImports.syntheticTxId,
      report: statementImports.report,
      txnCount: statementImports.txnCount,
    })
    .from(statementImports)
    .where(
      and(
        eq(statementImports.userId, session.id),
        eq(statementImports.accountId, accountId),
        eq(statementImports.kind, "extracto_detallado"),
        eq(statementImports.cycle, cycle),
      ),
    )
    .limit(1);

  const accountLabel = formatAccountLabel({
    name: account.name,
    currency: account.currency,
    institution: account.institution,
    metadata: account.metadata,
  });

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <Link href="/settings/accounts" className="hover:underline">
            Cuentas
          </Link>
          <span>/</span>
          <span>{accountLabel}</span>
          <span>/</span>
          <span>Consolidar</span>
        </div>
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-semibold">Consolidar ciclo {cycle}</h1>
          <span className="text-muted-foreground text-sm">{accountLabel}</span>
        </div>
        <p className="text-muted-foreground text-sm">
          Subí el extracto detallado del ciclo para reconciliar cuotas, tasas y generar los
          intereses-causados del cierre. El extracto es la fuente de verdad — lo que ya tenés en
          Findash se actualiza para coincidir con lo que publicó el banco.
        </p>
      </div>

      {existing ? (
        view === "run" ? (
          <ExistingRunDetail existing={existing} cycle={cycle} accountId={accountId} />
        ) : (
          <ExistingConsolidationCard existing={existing} cycle={cycle} accountId={accountId} />
        )
      ) : (
        <ConsolidateForm
          accountId={accountId}
          accountName={accountLabel}
          cycle={cycle}
          institutionSlug={account.institutionSlug}
        />
      )}
    </main>
  );
}

function ExistingRunDetail({
  existing,
  cycle,
  accountId,
}: {
  existing: {
    id: number;
    importedAt: Date;
    syntheticTxId: number | null;
    report: unknown;
    txnCount: number;
  };
  cycle: string;
  accountId: number;
}) {
  const report = (existing.report ?? null) as ConsolidationReport | null;
  return (
    <Card data-testid="consolidate-run-detail">
      <CardHeader className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            Run consolidado
            <Badge variant="secondary">{cycle}</Badge>
          </CardTitle>
          <CardDescription>
            Corrida el {formatBogotaDate(existing.importedAt)} · statement_import #{existing.id} ·{" "}
            {existing.txnCount} tx tocadas
          </CardDescription>
        </div>
        <Link
          href={`/settings/accounts/${accountId}/consolidate/${cycle}`}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Volver al resumen
        </Link>
      </CardHeader>
      <CardContent>
        {report ? (
          <ReportSection report={report} showHeading={false} />
        ) : (
          <p className="text-muted-foreground text-sm">
            Este run no tiene un reporte guardado (puede que se haya ejecutado antes de que lo
            persistiéramos). Re-ejecutalo desde la consola si necesitás el detalle.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ExistingConsolidationCard({
  existing,
  cycle,
  accountId,
}: {
  existing: {
    id: number;
    importedAt: Date;
    syntheticTxId: number | null;
    report: unknown;
    txnCount: number;
  };
  cycle: string;
  accountId: number;
}) {
  const report = (existing.report ?? {}) as Partial<ConsolidationReport>;
  const matchStats = report.matchStats;
  const intereses = report.intereses;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            Ciclo consolidado
            <Badge variant="secondary">{cycle}</Badge>
          </CardTitle>
          <CardDescription>
            Última corrida: {formatBogotaDate(existing.importedAt)} · {existing.txnCount}{" "}
            transacciones tocadas
          </CardDescription>
        </div>
        <Link
          href={`/settings/accounts/${accountId}/consolidate/${cycle}?view=run`}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Ver run
        </Link>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground text-xs">Matched</dt>
            <dd className="font-medium">{matchStats?.matched ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Updates aplicados</dt>
            <dd className="font-medium">{matchStats?.matchedWillChange ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Insertados</dt>
            <dd className="font-medium">{matchStats?.insertedMissing ?? "—"}</dd>
          </div>
          <div className="col-span-2 sm:col-span-3">
            <dt className="text-muted-foreground text-xs">Intereses-causados</dt>
            <dd className="font-medium">
              {intereses
                ? intereses.status === "inserted"
                  ? `Insertado (tx ${intereses.txId})`
                  : `Skipped: ${intereses.reason}`
                : "—"}
            </dd>
          </div>
        </dl>
        <p className="text-muted-foreground mt-4 text-xs">
          Ya consolidado. Para re-aplicar, eliminá el run anterior desde la consola (no hay UI de
          rollback todavía).
        </p>
      </CardContent>
    </Card>
  );
}
