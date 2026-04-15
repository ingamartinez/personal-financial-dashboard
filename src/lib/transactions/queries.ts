import { and, asc, desc, eq, ilike, lt, lte, gte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, categories, transactions } from "@/lib/db/schema";

export const PAGE_SIZE = 50;

export type TxFilters = {
  from?: string;
  to?: string;
  accountId?: number;
  categorySlug?: string;
  q?: string;
  cursor?: string;
};

export type TxRow = {
  id: number;
  occurredAt: Date;
  amountCents: bigint;
  currency: "COP" | "USD";
  descriptionRaw: string;
  descriptionClean: string | null;
  merchant: string | null;
  categorySlug: string | null;
  classificationMethod: "rule" | "ai" | "manual" | "unclassified";
  source: "apple_pay" | "sms" | "ocr" | "csv" | "recurring" | "manual";
  accountId: number;
  accountName: string;
};

export type TxListResult = {
  rows: TxRow[];
  nextCursor: string | null;
};

export function encodeCursor(occurredAt: Date, id: number): string {
  return Buffer.from(`${occurredAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { occurredAt: Date; id: number } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const [iso, idStr] = decoded.split("|");
    const occurredAt = new Date(iso);
    const id = Number(idStr);
    if (isNaN(occurredAt.getTime()) || !Number.isFinite(id)) return null;
    return { occurredAt, id };
  } catch {
    return null;
  }
}

export async function listTransactions(filters: TxFilters): Promise<TxListResult> {
  const conditions = [];

  if (filters.from) conditions.push(gte(transactions.occurredAt, new Date(filters.from)));
  if (filters.to) {
    const to = new Date(filters.to);
    to.setUTCHours(23, 59, 59, 999);
    conditions.push(lte(transactions.occurredAt, to));
  }
  if (filters.accountId) conditions.push(eq(transactions.accountId, filters.accountId));
  if (filters.categorySlug) conditions.push(eq(transactions.categorySlug, filters.categorySlug));
  if (filters.q) {
    const term = `%${filters.q}%`;
    conditions.push(
      or(
        ilike(transactions.descriptionRaw, term),
        ilike(transactions.descriptionClean, term),
        ilike(transactions.merchant, term),
      )!,
    );
  }
  if (filters.cursor) {
    const c = decodeCursor(filters.cursor);
    if (c) {
      conditions.push(
        or(
          lt(transactions.occurredAt, c.occurredAt),
          and(eq(transactions.occurredAt, c.occurredAt), lt(transactions.id, c.id)),
        )!,
      );
    }
  }

  const rows = await db
    .select({
      id: transactions.id,
      occurredAt: transactions.occurredAt,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      descriptionRaw: transactions.descriptionRaw,
      descriptionClean: transactions.descriptionClean,
      merchant: transactions.merchant,
      categorySlug: transactions.categorySlug,
      classificationMethod: transactions.classificationMethod,
      source: transactions.source,
      accountId: transactions.accountId,
      accountName: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(transactions.occurredAt), desc(transactions.id))
    .limit(PAGE_SIZE + 1);

  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const last = page.at(-1);
  const nextCursor = hasMore && last ? encodeCursor(last.occurredAt, last.id) : null;

  return { rows: page, nextCursor };
}

export async function listAccounts() {
  return db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.active, true))
    .orderBy(asc(accounts.name));
}

export async function listCategories() {
  return db
    .select({ slug: categories.slug, name: categories.name, parentSlug: categories.parentSlug })
    .from(categories)
    .orderBy(asc(categories.sortOrder), asc(categories.name));
}

export async function countTotal(filters: Omit<TxFilters, "cursor">): Promise<number> {
  const conditions = [];
  if (filters.from) conditions.push(gte(transactions.occurredAt, new Date(filters.from)));
  if (filters.to) {
    const to = new Date(filters.to);
    to.setUTCHours(23, 59, 59, 999);
    conditions.push(lte(transactions.occurredAt, to));
  }
  if (filters.accountId) conditions.push(eq(transactions.accountId, filters.accountId));
  if (filters.categorySlug) conditions.push(eq(transactions.categorySlug, filters.categorySlug));
  if (filters.q) {
    const term = `%${filters.q}%`;
    conditions.push(
      or(
        ilike(transactions.descriptionRaw, term),
        ilike(transactions.descriptionClean, term),
        ilike(transactions.merchant, term),
      )!,
    );
  }
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(transactions)
    .where(conditions.length ? and(...conditions) : undefined);
  return row?.n ?? 0;
}
