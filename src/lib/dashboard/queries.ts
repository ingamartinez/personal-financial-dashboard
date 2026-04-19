import { aliasedTable, and, asc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, categories, counterparties, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { toCop } from "@/lib/money";
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
  return db
    .select({
      id: accounts.id,
      name: accounts.name,
      institution: accounts.institution,
      type: accounts.type,
      currency: accounts.currency,
      balanceCents: accounts.balanceCents,
    })
    .from(accounts)
    .where(
      and(eq(accounts.userId, userId), eq(accounts.active, true), notDeleted(accounts.deletedAt)),
    )
    .orderBy(asc(accounts.name));
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
    .leftJoin(categories, eq(categories.slug, transactions.categorySlug))
    .leftJoin(rootCategories, eq(rootCategories.slug, rootSlug))
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.occurredAt, start),
        lt(transactions.occurredAt, end),
        sql`${transactions.amountCents} < 0`,
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
    .leftJoin(categories, eq(categories.slug, transactions.categorySlug))
    .leftJoin(counterparties, eq(counterparties.id, transactions.counterpartyId))
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.occurredAt, start),
        lt(transactions.occurredAt, end),
        sql`${transactions.amountCents} < 0`,
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
