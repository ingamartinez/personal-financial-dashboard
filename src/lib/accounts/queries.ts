import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, physicalCards, type AccountMetadata } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { toCop } from "@/lib/money";
import type { AccountType, Currency } from "@/lib/types";

export type PhysicalCardSummary = {
  id: string;
  creditLimitCents: bigint;
  statementCutoffDay: number | null;
  network: string | null;
  last4: string | null;
};

export type AccountDetail = {
  id: number;
  name: string;
  institution: string;
  type: AccountType;
  currency: Currency;
  balanceCents: bigint;
  active: boolean;
  metadata: AccountMetadata;
  physicalCardId: string | null;
  physicalCard: PhysicalCardSummary | null;
};

export async function listAccountsDetailed(userId: number): Promise<AccountDetail[]> {
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
      pcId: physicalCards.id,
      pcCreditLimitCents: physicalCards.creditLimitCents,
      pcStatementCutoffDay: physicalCards.statementCutoffDay,
      pcNetwork: physicalCards.network,
      pcLast4: physicalCards.last4,
    })
    .from(accounts)
    .leftJoin(
      physicalCards,
      and(
        eq(physicalCards.id, accounts.physicalCardId),
        // Tenancy guard: never join across users even if a FK were ever corrupted
        // (see engram `per-user-table-join-tenant-safety`).
        eq(physicalCards.userId, accounts.userId),
      ),
    )
    .where(and(eq(accounts.userId, userId), notDeleted(accounts.deletedAt)))
    .orderBy(asc(accounts.type), asc(accounts.institution), asc(accounts.name));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    institution: r.institution,
    type: r.type,
    currency: r.currency,
    balanceCents: r.balanceCents,
    active: r.active,
    metadata: r.metadata,
    physicalCardId: r.physicalCardId,
    physicalCard: r.pcId
      ? {
          id: r.pcId,
          creditLimitCents: r.pcCreditLimitCents!,
          statementCutoffDay: r.pcStatementCutoffDay,
          network: r.pcNetwork,
          last4: r.pcLast4,
        }
      : null,
  }));
}

/**
 * Returns the available credit (in COP cents) for a physical card with a shared
 * COP cupo spanning multiple sub-accounts (#346). USD balances are converted to
 * COP at `copPerUsd`. Credit-card balances are stored as negative debt, so the
 * formula is:
 *
 *   available = credit_limit_cents + sum(COP balances) + sum(USD balances) * rate
 *
 * Returns null when no physical card is found for `(userId, physicalCardId)` —
 * tenancy guard is enforced via the WHERE clause.
 */
export async function getAvailableCreditCOP(
  userId: number,
  physicalCardId: string,
  copPerUsd: number,
): Promise<bigint | null> {
  const [row] = await db
    .select({
      creditLimitCents: physicalCards.creditLimitCents,
      copDebtCents: sql<string>`
        COALESCE(SUM(CASE WHEN ${accounts.currency} = 'COP' THEN ${accounts.balanceCents} ELSE 0 END), 0)
      `,
      usdDebtCents: sql<string>`
        COALESCE(SUM(CASE WHEN ${accounts.currency} = 'USD' THEN ${accounts.balanceCents} ELSE 0 END), 0)
      `,
    })
    .from(physicalCards)
    .leftJoin(
      accounts,
      and(
        eq(accounts.physicalCardId, physicalCards.id),
        // Tenancy guard on the join too.
        eq(accounts.userId, physicalCards.userId),
        notDeleted(accounts.deletedAt),
      ),
    )
    .where(and(eq(physicalCards.id, physicalCardId), eq(physicalCards.userId, userId)))
    .groupBy(physicalCards.id, physicalCards.creditLimitCents);

  if (!row) return null;

  const copDebt = BigInt(row.copDebtCents);
  const usdDebt = BigInt(row.usdDebtCents);
  return row.creditLimitCents + copDebt + toCop(usdDebt, "USD", copPerUsd);
}
