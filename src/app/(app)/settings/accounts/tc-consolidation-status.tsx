// #419: Per-account TC consolidation state rendered above the accounts
// manager. Shows the last 3 cycles per credit-card account with status badges
// and a "Consolidar" shortcut on pending ones — the dashboard banner flags
// users, this is where they complete the work.
//
// #431: linked multi-currency plastics (Mastercard COP + USD share one
// physicalCardId) collapse into ONE block with one row per cycle. The
// backend still writes one statement_imports row per account; the UI just
// reflects that the extract is plastic-level.

import Link from "next/link";
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { accounts, type AccountMetadata } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { formatAccountLabel } from "@/lib/accounts/format";
import { recentCycles, type CycleStatus } from "@/lib/accounts/cycles";
import {
  groupAccountsForConsolidation,
  type CycleGroup,
  type GroupAccount,
} from "@/lib/accounts/cycle-groups";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  SkipCycleButton,
  UnskipCycleLink,
} from "@/app/(app)/settings/accounts/[accountId]/consolidate/skip-cycle-actions-ui";

type TcAccount = GroupAccount & { metadata: AccountMetadata | null };

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
    case "skipped":
      return "omitido";
  }
}

function groupDisplayLabel(group: CycleGroup<TcAccount>): string {
  const first = group.accounts[0];
  if (group.isMultiCurrency) {
    // Drop the currency suffix — `first.name` already embeds the plastic's
    // *last4 (e.g. "Bancolombia Mastercard *7291"), which is plastic-level.
    return first.name;
  }
  return formatAccountLabel({
    name: first.name,
    currency: first.currency,
    institution: first.institution ?? undefined,
    metadata: first.metadata,
  });
}

function multiCurrencySubtitle(currencies: readonly string[]): string {
  // Matches the copy from the issue body: "COP + USD · 1 extracto, 2 hojas".
  const currencyPart = currencies.join(" + ");
  return `${currencyPart} · 1 extracto, ${currencies.length} hoja${currencies.length === 1 ? "" : "s"}`;
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
      physicalCardId: accounts.physicalCardId,
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
        count: 6,
      }),
    })),
  );

  const groups = groupAccountsForConsolidation(perAccount);
  const hasPending = groups.some((g) => g.cycles.some((c) => c.status === "pending"));

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
          {groups.map((group) => {
            const label = groupDisplayLabel(group);
            return (
              <li key={group.key} className="flex flex-col gap-2">
                <div className="text-sm font-medium">{label}</div>
                <div className="flex flex-wrap gap-2">
                  {group.cycles.map((cycle) => (
                    <div
                      key={cycle.cycle}
                      className={
                        cycle.status === "no-activity" || cycle.status === "skipped"
                          ? "flex flex-col gap-1 rounded-md border px-3 py-2 text-sm opacity-70"
                          : "flex flex-col gap-1 rounded-md border px-3 py-2 text-sm"
                      }
                    >
                      <div className="flex items-center gap-2">
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
                            cycle.status === "no-activity" || cycle.status === "skipped"
                              ? "text-muted-foreground"
                              : undefined
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
                          <span className="text-muted-foreground text-xs">
                            +{cycle.daysOverdue}d
                          </span>
                        ) : null}
                        {cycle.status === "pending" ? (
                          <>
                            <Link
                              href={`/settings/accounts/${group.primaryAccountId}/consolidate/${cycle.cycle}`}
                              className={buttonVariants({ variant: "outline", size: "sm" })}
                            >
                              Consolidar
                            </Link>
                            <SkipCycleButton
                              accountId={group.primaryAccountId}
                              cycle={cycle.cycle}
                            />
                          </>
                        ) : null}
                        {cycle.status === "skipped" ? (
                          <UnskipCycleLink accountId={group.primaryAccountId} cycle={cycle.cycle} />
                        ) : null}
                        {cycle.status === "consolidated" ? (
                          <Link
                            href={`/settings/accounts/${group.primaryAccountId}/consolidate/${cycle.cycle}`}
                            className="text-muted-foreground text-xs underline"
                          >
                            Ver run
                          </Link>
                        ) : null}
                      </div>
                      {group.isMultiCurrency ? (
                        <span className="text-muted-foreground text-xs">
                          {multiCurrencySubtitle(cycle.currencies)}
                        </span>
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
