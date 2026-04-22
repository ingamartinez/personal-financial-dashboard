import { aliasedTable, and, asc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, categories, counterparties, transactions } from "@/lib/db/schema";
import { notAdjustment, notDeleted } from "@/lib/db/helpers";
import { toCop } from "@/lib/money";
import {
  derivedBalanceCentsSql,
  groupCreditCards,
  listAccountsDetailed,
} from "@/lib/accounts/queries";
import { computeNextPayment } from "@/lib/accounts/next-payment";
import type { AccountType, CounterpartyType, Currency } from "@/lib/types";

export function currentMonthRange(now = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export type AccountStatus = {
  id: number;
  name: string;
  institution: string;
  type: AccountType;
  currency: Currency;
  balanceCents: bigint;
};

export async function getAccountStatuses(userId: number): Promise<AccountStatus[]> {
  const rows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      institution: accounts.institution,
      type: accounts.type,
      currency: accounts.currency,
      balanceCents: derivedBalanceCentsSql,
    })
    .from(accounts)
    .where(
      and(eq(accounts.userId, userId), eq(accounts.active, true), notDeleted(accounts.deletedAt)),
    )
    .orderBy(asc(accounts.name));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    institution: r.institution,
    type: r.type,
    currency: r.currency,
    balanceCents: BigInt(r.balanceCents),
  }));
}

export type NetWorth = {
  totalCopCents: bigint;
  copCents: bigint;
  usdCents: bigint;
};

export async function getNetWorth(userId: number, copPerUsd: number): Promise<NetWorth> {
  const list = await getAccountStatuses(userId);
  let copCents = BigInt(0);
  let usdCents = BigInt(0);
  for (const a of list) {
    if (a.currency === "USD") usdCents += a.balanceCents;
    else copCents += a.balanceCents;
  }
  const totalCopCents = copCents + toCop(usdCents, "USD", copPerUsd);
  return { totalCopCents, copCents, usdCents };
}

export type MonthlyFlow = {
  incomeCopCents: bigint;
  expenseCopCents: bigint;
  netCopCents: bigint;
};

export async function getMonthlyFlow(
  userId: number,
  copPerUsd: number,
  now = new Date(),
): Promise<MonthlyFlow> {
  const { start, end } = currentMonthRange(now);

  const rows = await db
    .select({
      currency: transactions.currency,
      incomeCents: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.amountCents} > 0 THEN ${transactions.amountCents} ELSE 0 END), 0)`,
      expenseCents: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.amountCents} < 0 THEN -${transactions.amountCents} ELSE 0 END), 0)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.occurredAt, start),
        lt(transactions.occurredAt, end),
        notAdjustment(transactions.isAdjustment),
        notDeleted(transactions.deletedAt),
      ),
    )
    .groupBy(transactions.currency);

  let incomeCopCents = BigInt(0);
  let expenseCopCents = BigInt(0);
  for (const r of rows) {
    incomeCopCents += toCop(BigInt(r.incomeCents), r.currency, copPerUsd);
    expenseCopCents += toCop(BigInt(r.expenseCents), r.currency, copPerUsd);
  }
  return {
    incomeCopCents,
    expenseCopCents,
    netCopCents: incomeCopCents - expenseCopCents,
  };
}

export type CategorySlice = {
  slug: string;
  name: string;
  color: string | null;
  amountCopCents: bigint;
};

export async function getCategoryBreakdown(
  userId: number,
  copPerUsd: number,
  now = new Date(),
): Promise<CategorySlice[]> {
  const { start, end } = currentMonthRange(now);

  const rootCategories = aliasedTable(categories, "root_categories");
  const rootSlug = sql<string | null>`COALESCE(${categories.parentSlug}, ${categories.slug})`;

  const rows = await db
    .select({
      slug: rootSlug,
      currency: transactions.currency,
      name: rootCategories.name,
      color: rootCategories.color,
      sumCents: sql<string>`SUM(-${transactions.amountCents})`,
    })
    .from(transactions)
    .leftJoin(
      categories,
      and(
        eq(categories.slug, transactions.categorySlug),
        eq(categories.userId, transactions.userId),
      ),
    )
    .leftJoin(
      rootCategories,
      and(eq(rootCategories.slug, rootSlug), eq(rootCategories.userId, transactions.userId)),
    )
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.occurredAt, start),
        lt(transactions.occurredAt, end),
        sql`${transactions.amountCents} < 0`,
        notAdjustment(transactions.isAdjustment),
        notDeleted(transactions.deletedAt),
      ),
    )
    .groupBy(rootSlug, transactions.currency, rootCategories.name, rootCategories.color);

  const merged = new Map<string, CategorySlice>();
  for (const r of rows) {
    const slug = r.slug ?? "uncategorized";
    const name = r.name ?? "Uncategorized";
    const cents = toCop(BigInt(r.sumCents), r.currency, copPerUsd);
    const existing = merged.get(slug);
    if (existing) {
      existing.amountCopCents += cents;
    } else {
      merged.set(slug, { slug, name, color: r.color, amountCopCents: cents });
    }
  }
  return Array.from(merged.values()).sort((a, b) => (a.amountCopCents < b.amountCopCents ? 1 : -1));
}

export type TopExpense = {
  id: number;
  occurredAt: Date;
  descriptionRaw: string;
  descriptionClean: string | null;
  merchant: string | null;
  counterparty: {
    id: number;
    displayName: string;
    type: CounterpartyType;
  } | null;
  categoryName: string | null;
  amountCents: bigint;
  currency: Currency;
  amountCopCents: bigint;
  accountName: string;
};

export async function getTopExpenses(
  userId: number,
  copPerUsd: number,
  now = new Date(),
  limit = 5,
): Promise<TopExpense[]> {
  const { start, end } = currentMonthRange(now);
  const rateMicros = Math.round(copPerUsd * 1_000_000);
  const rows = await db
    .select({
      id: transactions.id,
      occurredAt: transactions.occurredAt,
      descriptionRaw: transactions.descriptionRaw,
      descriptionClean: transactions.descriptionClean,
      merchant: transactions.merchant,
      categoryName: categories.name,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      accountName: accounts.name,
      cpId: counterparties.id,
      cpDisplayName: counterparties.displayName,
      cpType: counterparties.type,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(
      categories,
      and(
        eq(categories.slug, transactions.categorySlug),
        eq(categories.userId, transactions.userId),
      ),
    )
    .leftJoin(counterparties, eq(counterparties.id, transactions.counterpartyId))
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.occurredAt, start),
        lt(transactions.occurredAt, end),
        sql`${transactions.amountCents} < 0`,
        notAdjustment(transactions.isAdjustment),
        notDeleted(transactions.deletedAt),
      ),
    )
    .orderBy(
      sql`(CASE WHEN ${transactions.currency} = 'USD' THEN -${transactions.amountCents} * ${sql.raw(String(rateMicros))} / 1000000 ELSE -${transactions.amountCents} END) DESC`,
    )
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    occurredAt: r.occurredAt,
    descriptionRaw: r.descriptionRaw,
    descriptionClean: r.descriptionClean,
    merchant: r.merchant,
    counterparty: r.cpId ? { id: r.cpId, displayName: r.cpDisplayName!, type: r.cpType! } : null,
    categoryName: r.categoryName,
    amountCents: r.amountCents,
    currency: r.currency,
    amountCopCents: toCop(BigInt(-1) * r.amountCents, r.currency, copPerUsd),
    accountName: r.accountName,
  }));
}

export type CreditCardsSummary = {
  cardCount: number;
  debtCopCents: bigint;
  limitCopCents: bigint;
  availableCopCents: bigint;
  usedPct: number;
  nextPayment: { date: string; daysUntil: number } | null;
};

/**
 * Aggregates active credit_card accounts into a single dashboard summary
 * (#364). Shared-cupo pairs are treated as one card; single-currency cards
 * contribute their own limit/available from metadata. Returns COP-normalized
 * totals and the nearest upcoming payment date across all cards.
 */
export async function getCreditCardsSummary(
  userId: number,
  copPerUsd: number,
  now = new Date(),
): Promise<CreditCardsSummary> {
  const all = await listAccountsDetailed(userId);
  const active = all.filter((a) => a.active && a.type === "credit_card");
  const groups = groupCreditCards(active);

  let debtCopCents = BigInt(0);
  let limitCopCents = BigInt(0);
  let availableCopCents = BigInt(0);
  let nearest: { date: string; daysUntil: number } | null = null;

  const toCopCents = (cents: bigint, currency: Currency): bigint =>
    currency === "USD" ? toCop(cents, "USD", copPerUsd) : cents;

  for (const group of groups) {
    const primary = group[0];
    const isShared = group.length > 1 || Boolean(primary.physicalCard);

    // Debt — sum sub-account balances (always negative for credit cards),
    // converting USD → COP.
    for (const s of group) {
      debtCopCents += toCopCents(s.balanceCents, s.currency);
    }

    // Limit + available — shared cards use physical_cards (COP limit);
    // single cards read metadata and convert if USD-native.
    if (isShared && primary.physicalCard) {
      const limit = primary.physicalCard.creditLimitCents;
      limitCopCents += limit;
      let available = limit;
      for (const s of group) {
        available += toCopCents(s.balanceCents, s.currency);
      }
      availableCopCents += available;
    } else {
      const md = primary.metadata;
      if (md.creditLimitCents && md.creditLimitCents > 0) {
        const limitNative = BigInt(md.creditLimitCents);
        // #420: always derive — stop reading `md.availableCreditCents`
        // snapshot since it stays stale between balance-adjusts.
        const availNative = limitNative + primary.balanceCents;
        limitCopCents += toCopCents(limitNative, primary.currency);
        availableCopCents += toCopCents(availNative, primary.currency);
      }
    }

    // Next payment — same derivation as the /accounts tile.
    const cutoffDay =
      isShared && primary.physicalCard
        ? primary.physicalCard.statementCutoffDay
        : (primary.metadata.cutoffDay ?? null);
    const nextDate = computeNextPayment(cutoffDay, now);
    if (nextDate) {
      const target = new Date(`${nextDate}T12:00:00Z`).getTime();
      const daysUntil = Math.ceil((target - now.getTime()) / (24 * 60 * 60 * 1000));
      if (!nearest || daysUntil < nearest.daysUntil) {
        nearest = { date: nextDate, daysUntil };
      }
    }
  }

  const usedCents = limitCopCents - availableCopCents;
  const usedPct =
    limitCopCents > BigInt(0)
      ? Math.min(100, Math.max(0, Number((usedCents * BigInt(10000)) / limitCopCents) / 100))
      : 0;

  return {
    cardCount: groups.length,
    debtCopCents,
    limitCopCents,
    availableCopCents,
    usedPct,
    nextPayment: nearest,
  };
}
