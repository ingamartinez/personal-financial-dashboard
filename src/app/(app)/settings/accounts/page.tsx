import { asc, and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, physicalCards } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { derivedBalanceCentsSql } from "@/lib/accounts/queries";
import { getSessionUser } from "@/lib/auth/session";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { AccountsManager, type AccountRow } from "./accounts-manager";
import { TcConsolidationStatus } from "./tc-consolidation-status";

export const dynamic = "force-dynamic";

export default async function SettingsAccountsPage() {
  const session = await getSessionUser();
  const fx = await getCurrentFxRate();
  const rows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      institution: accounts.institution,
      institutionSlug: accounts.institutionSlug,
      type: accounts.type,
      currency: accounts.currency,
      balanceCents: derivedBalanceCentsSql,
      active: accounts.active,
      metadata: accounts.metadata,
      physicalCardId: accounts.physicalCardId,
      pcName: physicalCards.name,
      pcCreditLimitCents: physicalCards.creditLimitCents,
      pcStatementCutoffDay: physicalCards.statementCutoffDay,
      pcLast4: physicalCards.last4,
      pcNetwork: physicalCards.network,
    })
    .from(accounts)
    .leftJoin(
      physicalCards,
      and(
        eq(physicalCards.id, accounts.physicalCardId),
        // Tenancy guard on the join — never surface another user's physical card
        // even if a FK were ever corrupted (see per-user-table-join-tenant-safety).
        eq(physicalCards.userId, accounts.userId),
      ),
    )
    .where(and(eq(accounts.userId, session.id), notDeleted(accounts.deletedAt)))
    .orderBy(asc(accounts.type), asc(accounts.name));

  const items: AccountRow[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    institution: r.institution,
    institutionSlug: r.institutionSlug,
    type: r.type,
    currency: r.currency,
    balanceCents: r.balanceCents.toString(),
    active: r.active,
    metadata: r.metadata,
    physicalCardId: r.physicalCardId,
    physicalCard: r.physicalCardId
      ? {
          id: r.physicalCardId,
          name: r.pcName,
          creditLimitCents: r.pcCreditLimitCents!.toString(),
          statementCutoffDay: r.pcStatementCutoffDay,
          last4: r.pcLast4,
          network: r.pcNetwork,
        }
      : null,
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
      <AccountsManager items={items} copPerUsd={fx.rate} />
      <TcConsolidationStatus userId={session.id} />
    </main>
  );
}
