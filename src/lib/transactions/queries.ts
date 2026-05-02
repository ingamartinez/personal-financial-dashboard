import { and, asc, desc, eq, gt, ilike, isNull, lt, lte, gte, ne, or, sql } from "drizzle-orm";
import { notDeleted } from "@/lib/db/helpers";
import { db } from "@/lib/db";
import {
  accounts,
  categories,
  counterparties,
  counterpartyAliases,
  recurringTransactions,
  transactions,
} from "@/lib/db/schema";
import type { CounterpartyAlias, CounterpartyBrief, TxRow } from "@/lib/types";

export type { CounterpartyAlias, CounterpartyBrief, TxRow };

export const PAGE_SIZE = 50;

export type TxFilters = {
  from?: string;
  to?: string;
  accountId?: number;
  categorySlug?: string;
  q?: string;
  cursor?: string;
  hideAdjustments?: boolean;
  includeArchived?: boolean;
  // #416: when true, limits the list to multi-cuota TC purchases missing an
  // explicit rate — the UI filters to "compras a cuotas sin tasa" so the
  // user can supply the EM from the extract. Translates to
  // `installments_total > 1 AND installment_rate_bps IS NULL`.
  needsRate?: boolean;
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

export async function listTransactions(userId: number, filters: TxFilters): Promise<TxListResult> {
  const conditions = [eq(transactions.userId, userId)];
  if (!filters.includeArchived) conditions.push(notDeleted(transactions.deletedAt));

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
  if (filters.hideAdjustments) conditions.push(eq(transactions.isAdjustment, false));
  if (filters.needsRate) {
    conditions.push(gt(transactions.installmentsTotal, 1));
    conditions.push(isNull(transactions.installmentRateEmX10k));
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
      classificationConfidence: transactions.classificationConfidence,
      source: transactions.source,
      isAdjustment: transactions.isAdjustment,
      accountId: transactions.accountId,
      accountName: accounts.name,
      accountType: accounts.type,
      installmentsTotal: transactions.installmentsTotal,
      installmentRateEmX10k: transactions.installmentRateEmX10k,
      deletedAt: transactions.deletedAt,
      cpId: counterparties.id,
      cpDisplayName: counterparties.displayName,
      cpType: counterparties.type,
      cpIsSalary: counterparties.isSalary,
      cpDefaultCategorySlug: counterparties.defaultCategorySlug,
      cpNotes: counterparties.notes,
      cpAliases: sql<CounterpartyAlias[] | null>`(
        SELECT COALESCE(
          json_agg(json_build_object('id', a.id, 'kind', a.kind, 'value', a.value) ORDER BY a.id),
          '[]'::json
        )
        FROM ${counterpartyAliases} a
        WHERE a.counterparty_id = ${counterparties.id}
      )`,
      // #621: recurring link fields — null when not linked
      recurringId: transactions.recurringId,
      recurringYearMonth: transactions.recurringYearMonth,
      recurringLabel: recurringTransactions.label,
      // #642: transfer pairing
      channel: transactions.channel,
      transferGroupId: transactions.transferGroupId,
      // #528: PROJECTED rawData — only `fx` and `merged_statement.fx` are shipped
      // to the client so MoneyFrozen can resolve the historical TRM. Do NOT add
      // other rawData keys here without thinking about leaking server-side
      // metadata (email subjects, parser hints, dedup hashes) to the browser.
      // Shape stays compatible with TxForConversion / extractFxMetadataWithFallback.
      rawData: sql<Record<string, unknown> | null>`CASE
        WHEN ${transactions.rawData} IS NULL THEN NULL
        ELSE jsonb_build_object(
          'fx', ${transactions.rawData} -> 'fx',
          'merged_statement', jsonb_build_object(
            'fx', ${transactions.rawData} -> 'merged_statement' -> 'fx'
          )
        )
      END`.as("raw_data"),
      // #713 (Epic I B.1+B.2): anomaly flags for badge rendering
      anomalyFlags: transactions.anomalyFlags,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(counterparties, eq(counterparties.id, transactions.counterpartyId))
    .leftJoin(
      recurringTransactions,
      and(
        eq(recurringTransactions.id, transactions.recurringId),
        eq(recurringTransactions.userId, transactions.userId),
      ),
    )
    .where(and(...conditions))
    .orderBy(desc(transactions.occurredAt), desc(transactions.id))
    .limit(PAGE_SIZE + 1);

  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const last = page.at(-1);
  const nextCursor = hasMore && last ? encodeCursor(last.occurredAt, last.id) : null;

  const shaped: TxRow[] = page.map((r) => ({
    id: r.id,
    occurredAt: r.occurredAt,
    amountCents: r.amountCents,
    currency: r.currency,
    descriptionRaw: r.descriptionRaw,
    descriptionClean: r.descriptionClean,
    merchant: r.merchant,
    categorySlug: r.categorySlug,
    classificationMethod: r.classificationMethod,
    classificationConfidence: r.classificationConfidence,
    source: r.source,
    isAdjustment: r.isAdjustment,
    accountId: r.accountId,
    accountName: r.accountName,
    accountType: r.accountType,
    installmentsTotal: r.installmentsTotal,
    installmentRateEmX10k: r.installmentRateEmX10k,
    deletedAt: r.deletedAt,
    counterparty: r.cpId
      ? {
          id: r.cpId,
          displayName: r.cpDisplayName!,
          type: r.cpType!,
          isSalary: r.cpIsSalary ?? false,
          defaultCategorySlug: r.cpDefaultCategorySlug,
          notes: r.cpNotes,
          aliases: r.cpAliases ?? [],
        }
      : null,
    recurringId: r.recurringId,
    recurringYearMonth: r.recurringYearMonth,
    recurringLabel: r.recurringLabel ?? null,
    channel: r.channel,
    transferGroupId: r.transferGroupId ?? null,
    rawData: r.rawData,
    anomalyFlags: r.anomalyFlags ?? null,
  }));

  return { rows: shaped, nextCursor };
}

/**
 * Compact counterparty list for the merge selector in CounterpartyDialog.
 * Ordered by hit_count DESC so the most-used show first.
 */
export async function listCounterparties(userId: number): Promise<CounterpartyBrief[]> {
  return db
    .select({
      id: counterparties.id,
      displayName: counterparties.displayName,
      type: counterparties.type,
    })
    .from(counterparties)
    .where(eq(counterparties.userId, userId))
    .orderBy(desc(counterparties.hitCount), asc(counterparties.displayName));
}

/**
 * Same as `listCounterparties` but excludes one id (used when building the
 * merge target select — a counterparty cannot merge into itself).
 */
export async function listCounterpartiesExcept(
  userId: number,
  excludeId: number,
): Promise<CounterpartyBrief[]> {
  return db
    .select({
      id: counterparties.id,
      displayName: counterparties.displayName,
      type: counterparties.type,
    })
    .from(counterparties)
    .where(and(eq(counterparties.userId, userId), ne(counterparties.id, excludeId)))
    .orderBy(desc(counterparties.hitCount), asc(counterparties.displayName));
}

export async function listAccounts(userId: number) {
  return db
    .select({ id: accounts.id, name: accounts.name, currency: accounts.currency })
    .from(accounts)
    .where(
      and(eq(accounts.userId, userId), eq(accounts.active, true), notDeleted(accounts.deletedAt)),
    )
    .orderBy(asc(accounts.name));
}

export async function listCategories(userId: number) {
  return db
    .select({ slug: categories.slug, name: categories.name, parentSlug: categories.parentSlug })
    .from(categories)
    .where(and(eq(categories.userId, userId), notDeleted(categories.deletedAt)))
    .orderBy(asc(categories.sortOrder), asc(categories.name));
}

export async function countUnclassified(userId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.classificationMethod, "unclassified"),
        notDeleted(transactions.deletedAt),
      ),
    );
  return row?.n ?? 0;
}

export async function countTotal(
  userId: number,
  filters: Omit<TxFilters, "cursor">,
): Promise<number> {
  const conditions = [eq(transactions.userId, userId)];
  if (!filters.includeArchived) conditions.push(notDeleted(transactions.deletedAt));
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
  if (filters.hideAdjustments) conditions.push(eq(transactions.isAdjustment, false));
  if (filters.needsRate) {
    conditions.push(gt(transactions.installmentsTotal, 1));
    conditions.push(isNull(transactions.installmentRateEmX10k));
  }
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(transactions)
    .where(and(...conditions));
  return row?.n ?? 0;
}

/**
 * #416: count live multi-cuota TC purchases missing an explicit rate. Drives
 * the sticky banner on `/transactions` that prompts the user to supply the
 * rate from the month's extract. Soft-deleted rows excluded.
 */
export async function countNeedingRate(userId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        gt(transactions.installmentsTotal, 1),
        isNull(transactions.installmentRateEmX10k),
        notDeleted(transactions.deletedAt),
      ),
    );
  return row?.n ?? 0;
}
