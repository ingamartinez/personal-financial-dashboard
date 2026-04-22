// #419: Per-account TC consolidation state rendered above the accounts
// manager. Shows the last 3 cycles per credit-card account with status badges
// and a "Consolidar" shortcut on pending ones — the dashboard banner flags
// users, this is where they complete the work.

import Link from "next/link";
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { formatAccountLabel } from "@/lib/accounts/format";
import { recentCycles, type CycleStatus } from "@/lib/accounts/cycles";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function formatBogotaDate(d: Date): string {
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "America/Bogota",
  }).format(d);
}

function statusLabel(status: CycleStatus): string {
  switch (status) {
    case "consolidated":
      return "consolidado";
    case "pending":
      return "pendiente";
    case "in-progress":
      return "en curso";
    case "no-activity":
      return "sin actividad";
  }
}

export async function TcConsolidationStatus({ userId }: { userId: number }) {
  const tcAccounts = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      currency: accounts.currency,
      institution: accounts.institution,
      institutionSlug: accounts.institutionSlug,
      metadata: accounts.metadata,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.type, "credit_card"),
        eq(accounts.institutionSlug, "bancolombia"),
        notDeleted(accounts.deletedAt),
      ),
    )
    .orderBy(asc(accounts.name));

  if (tcAccounts.length === 0) return null;

  const perAccount = await Promise.all(
    tcAccounts.map(async (a) => ({
      account: a,
      cycles: await recentCycles({
        accountId: a.id,
        userId,
        metadata: a.metadata,
        count: 3,
      }),
    })),
  );

  const hasPending = perAccount.some((p) => p.cycles.some((c) => c.status === "pending"));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Consolidación mensual de TCs</CardTitle>
        <CardDescription>
          Al cierre de cada ciclo subí el extracto detallado para reconciliar cuotas, tasas y
          generar los intereses-causados del mes.{" "}
          {hasPending
            ? "Tenés al menos un ciclo pendiente."
            : "Todos los ciclos cerrados están consolidados."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-4">
          {perAccount.map(({ account, cycles }) => {
            const label = formatAccountLabel({
              name: account.name,
              currency: account.currency,
              institution: account.institution,
              metadata: account.metadata,
            });
            return (
              <li key={account.id} className="flex flex-col gap-2">
                <div className="text-sm font-medium">{label}</div>
                <div className="flex flex-wrap gap-2">
                  {cycles.map((cycle) => (
                    <div
                      key={cycle.cycle}
                      className={
                        cycle.status === "no-activity"
                          ? "flex items-center gap-2 rounded-md border px-3 py-2 text-sm opacity-70"
                          : "flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                      }
                    >
                      <span className="font-mono text-xs">{cycle.cycle}</span>
                      <Badge
                        variant={
                          cycle.status === "consolidated"
                            ? "default"
                            : cycle.status === "pending"
                              ? "secondary"
                              : "outline"
                        }
                        className={
                          cycle.status === "no-activity" ? "text-muted-foreground" : undefined
                        }
                      >
                        {statusLabel(cycle.status)}
                      </Badge>
                      {cycle.status === "consolidated" && cycle.consolidatedAt ? (
                        <span className="text-muted-foreground text-xs">
                          {formatBogotaDate(cycle.consolidatedAt)}
                        </span>
                      ) : null}
                      {cycle.status === "pending" && cycle.daysOverdue > 0 ? (
                        <span className="text-muted-foreground text-xs">+{cycle.daysOverdue}d</span>
                      ) : null}
                      {cycle.status === "pending" ? (
                        <Link
                          href={`/settings/accounts/${account.id}/consolidate/${cycle.cycle}`}
                          className={buttonVariants({ variant: "outline", size: "sm" })}
                        >
                          Consolidar
                        </Link>
                      ) : null}
                      {cycle.status === "consolidated" ? (
                        <Link
                          href={`/settings/accounts/${account.id}/consolidate/${cycle.cycle}`}
                          className="text-muted-foreground text-xs underline"
                        >
                          Ver run
                        </Link>
                      ) : null}
                    </div>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
