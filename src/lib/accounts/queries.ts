import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, physicalCards, type AccountMetadata } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { toCop } from "@/lib/money";
import type { AccountType, Currency } from "@/lib/types";

/**
 * Derived balance — snapshot-anchored since #562(c).
 *
 * When an `account_snapshots` row exists for this account, the balance is:
 *   snapshot.balance_cents  +  SUM(txs where occurred_at >= snapshot_date)
 * using the LATEST snapshot (ORDER BY snapshot_date DESC LIMIT 1).
 *
 * When NO snapshot exists, the formula falls back to the original behaviour:
 *   COALESCE(SUM(all non-archived transactions), 0)
 * This means existing accounts without snapshots are unaffected.
 *
 * Qualifiers are hard-coded because drizzle interpolates
 * `${accounts.id}` as a bare identifier (`"id"`), which inside the
 * subquery scope resolves to `transactions.id` — collapsing the
 * correlation and always returning 0.
 *
 * Archived transactions (`deleted_at IS NOT NULL`, see #375) are
 * excluded so that archiving a row removes it from the derived
 * balance — restoring reverses it.
 *
 * Returns `string` (postgres bigint wire format); callers must wrap
 * with `BigInt(...)`.
 */
export const derivedBalanceCentsSql = sql<string>`(
  SELECT COALESCE(
    -- Branch A: snapshot exists → anchor + delta since snapshot date.
    (
      SELECT s."balance_cents"
      FROM "account_snapshots" s
      WHERE s."account_id" = "accounts"."id"
      ORDER BY s."snapshot_date" DESC
      LIMIT 1
    ) + COALESCE(
      (
        SELECT SUM("transactions"."amount_cents")
        FROM "transactions"
        WHERE "transactions"."account_id" = "accounts"."id"
          AND "transactions"."deleted_at" IS NULL
          AND "transactions"."occurred_at" >= (
            SELECT s2."snapshot_date"
            FROM "account_snapshots" s2
            WHERE s2."account_id" = "accounts"."id"
            ORDER BY s2."snapshot_date" DESC
            LIMIT 1
          )
      ),
      0
    ),
    -- Branch B: no snapshot exists → original SUM-all behaviour.
    COALESCE(
      (
        SELECT SUM(t2."amount_cents")
        FROM "transactions" t2
        WHERE t2."account_id" = "accounts"."id"
          AND t2."deleted_at" IS NULL
      ),
      0
    )
  )
)`;

export type PhysicalCardSummary = {
  id: string;
  name: string | null;
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
      balanceCents: derivedBalanceCentsSql,
      active: accounts.active,
      metadata: accounts.metadata,
      physicalCardId: accounts.physicalCardId,
      pcId: physicalCards.id,
      pcName: physicalCards.name,
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
    balanceCents: BigInt(r.balanceCents),
    active: r.active,
    metadata: r.metadata,
    physicalCardId: r.physicalCardId,
    physicalCard: r.pcId
      ? {
          id: r.pcId,
          name: r.pcName,
          creditLimitCents: r.pcCreditLimitCents!,
          statementCutoffDay: r.pcStatementCutoffDay,
          network: r.pcNetwork,
          last4: r.pcLast4,
        }
      : null,
  }));
}

/**
 * Groups credit_card AccountDetail rows by physical_card — shared-cupo cards
 * (2+ sub-accounts sharing one physical_cards row) end up in the same group;
 * single-currency cards are single-member groups. Used by the /accounts page
 * and the dashboard Credit cards summary widget (#364).
 */
export function groupCreditCards(items: AccountDetail[]): AccountDetail[][] {
  const groups: AccountDetail[][] = [];
  const byPcId = new Map<string, AccountDetail[]>();
  for (const a of items) {
    if (a.physicalCardId && a.physicalCard) {
      const existing = byPcId.get(a.physicalCardId);
      if (existing) {
        existing.push(a);
      } else {
        const arr = [a];
        byPcId.set(a.physicalCardId, arr);
        groups.push(arr);
      }
    } else {
      groups.push([a]);
    }
  }
  return groups;
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
        COALESCE(SUM(CASE WHEN ${accounts.currency} = 'COP' THEN ${derivedBalanceCentsSql} ELSE 0 END), 0)
      `,
      usdDebtCents: sql<string>`
        COALESCE(SUM(CASE WHEN ${accounts.currency} = 'USD' THEN ${derivedBalanceCentsSql} ELSE 0 END), 0)
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
