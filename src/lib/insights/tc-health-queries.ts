/**
 * TC health-check DB helpers — pure data fetching, no BullMQ dependency.
 *
 * Extracted from the worker so the /insights page (RSC) can import these
 * without transitively pulling BullMQ / ioredis into the route module graph.
 *
 * Two query paths:
 *   - fetchMultiCurrencyCards: physical_cards LEFT JOIN accounts, aggregated into
 *     COP + USD debt buckets.
 *   - fetchSingleCurrencyCards: plain credit_card accounts (no physicalCardId).
 *
 * Snapshot builders convert raw DB rows into TcCardSnapshot values ready for
 * computeTcAlerts().
 */

import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { accounts, physicalCards, type AccountMetadata } from "@/lib/db/schema";
import { derivedBalanceCentsSql } from "@/lib/accounts/queries";
import { notDeleted } from "@/lib/db/helpers";
import { toCop } from "@/lib/money";
import { formatAccountLabel } from "@/lib/accounts/format";
import { nowInBogota, roundUtilizationPct, type BogotaYmd } from "@/lib/widgets/handlers/_shared";
import { computeNextCutoff } from "@/lib/widgets/handlers/tc-focus";
import type { TcCardSnapshot } from "@/lib/insights/tc-health";

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

export type MultiCurrencyRow = {
  id: string;
  name: string | null;
  institution: string;
  network: string | null;
  last4: string | null;
  creditLimitCents: bigint;
  statementCutoffDay: number | null;
  userId: number;
  /** SUM of COP sub-account balances (negative when in debt) */
  copDebtCents: bigint;
  /** SUM of USD sub-account balances (negative when in debt), in USD cents */
  usdDebtCents: bigint;
};

export type SingleCurrencyRow = {
  id: number;
  name: string;
  institution: string;
  currency: "COP" | "USD";
  metadata: AccountMetadata;
  userId: number;
  balanceCents: bigint;
};

const BI_ZERO = BigInt(0);

// ---------------------------------------------------------------------------
// Queries — two round-trips for the whole tenant roster, not N+1.
// Tenant safety: JOIN ON pairs user_id (memory per-user-table-join-tenant-safety).
// ---------------------------------------------------------------------------

export async function fetchMultiCurrencyCards(userId?: number): Promise<MultiCurrencyRow[]> {
  const rows = await db
    .select({
      id: physicalCards.id,
      name: physicalCards.name,
      institution: physicalCards.institution,
      network: physicalCards.network,
      last4: physicalCards.last4,
      creditLimitCents: physicalCards.creditLimitCents,
      statementCutoffDay: physicalCards.statementCutoffDay,
      userId: physicalCards.userId,
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
        // Tenancy guard: pair user_id in the JOIN ON clause (memory per-user-table-join-tenant-safety)
        eq(accounts.userId, physicalCards.userId),
        notDeleted(accounts.deletedAt),
      ),
    )
    .where(userId !== undefined ? eq(physicalCards.userId, userId) : undefined)
    .groupBy(
      physicalCards.id,
      physicalCards.name,
      physicalCards.institution,
      physicalCards.network,
      physicalCards.last4,
      physicalCards.creditLimitCents,
      physicalCards.statementCutoffDay,
      physicalCards.userId,
    );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    institution: r.institution,
    network: r.network,
    last4: r.last4,
    creditLimitCents: r.creditLimitCents,
    statementCutoffDay: r.statementCutoffDay ?? null,
    userId: r.userId,
    copDebtCents: BigInt(r.copDebtCents),
    usdDebtCents: BigInt(r.usdDebtCents),
  }));
}

export async function fetchSingleCurrencyCards(userId?: number): Promise<SingleCurrencyRow[]> {
  const rows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      institution: accounts.institution,
      currency: accounts.currency,
      metadata: accounts.metadata,
      userId: accounts.userId,
      balanceCents: derivedBalanceCentsSql,
    })
    .from(accounts)
    .where(
      and(
        userId !== undefined ? eq(accounts.userId, userId) : undefined,
        eq(accounts.type, "credit_card"),
        // Absence of physicalCardId distinguishes "plain" TCs from multi-currency sub-accounts
        isNull(accounts.physicalCardId),
        notDeleted(accounts.deletedAt),
      ),
    );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    institution: r.institution,
    currency: r.currency as "COP" | "USD",
    metadata: (r.metadata ?? {}) as AccountMetadata,
    userId: r.userId,
    balanceCents: BigInt(r.balanceCents),
  }));
}

// ---------------------------------------------------------------------------
// Snapshot builders — bigint math, no float coercions
// ---------------------------------------------------------------------------

export function buildMultiSnapshot(
  row: MultiCurrencyRow,
  copPerUsd: number,
  today: BogotaYmd,
): TcCardSnapshot {
  // Mirrors projectMultiCurrency in mis-tcs.ts
  const usdDebtInCop = toCop(row.usdDebtCents, "USD", copPerUsd);
  const availableCents = row.creditLimitCents + row.copDebtCents + usdDebtInCop;
  const usedCents = row.creditLimitCents - availableCents;
  const usedClamped = usedCents < BI_ZERO ? BI_ZERO : usedCents;

  const utilizationPct = roundUtilizationPct(usedClamped, row.creditLimitCents);

  const label =
    row.name?.trim() ||
    [row.institution, row.last4 ? `*${row.last4}` : null].filter(Boolean).join(" ") ||
    "Tarjeta de crédito";

  const daysToCutoff =
    row.statementCutoffDay !== null
      ? computeNextCutoff(row.statementCutoffDay, today).daysTo
      : null;

  return {
    cardId: `pc-${row.id}`,
    kind: "physical",
    label,
    cutoffDay: row.statementCutoffDay,
    // Multi-currency cards aggregate all debt into COP
    currency: "COP",
    creditLimitCents: row.creditLimitCents,
    usedCents: usedClamped,
    utilizationPct,
    daysToCutoff,
  };
}

export function buildSingleSnapshot(
  row: SingleCurrencyRow,
  copPerUsd: number,
  today: BogotaYmd,
): TcCardSnapshot {
  // Mirrors projectSingleCurrency in mis-tcs.ts
  const limitNativeCents = BigInt(row.metadata.creditLimitCents ?? 0);
  const usedNativeCents = row.balanceCents < BI_ZERO ? -row.balanceCents : BI_ZERO;

  // Utilization on native cents (ratio is invariant under positive-rate scaling)
  const utilizationPct = roundUtilizationPct(usedNativeCents, limitNativeCents);

  const cutoffDay = row.metadata.cutoffDay ?? null;
  const daysToCutoff = cutoffDay !== null ? computeNextCutoff(cutoffDay, today).daysTo : null;

  const label = formatAccountLabel(
    {
      name: row.name,
      currency: row.currency,
      institution: row.institution,
      metadata: { last4s: row.metadata.last4s ?? null },
    },
    { withInstitution: true },
  );

  return {
    cardId: `acc-${row.id}`,
    kind: "account",
    label,
    cutoffDay,
    // Single-currency card retains its native currency (COP or USD)
    currency: row.currency,
    creditLimitCents: limitNativeCents,
    usedCents: usedNativeCents,
    utilizationPct,
    daysToCutoff,
  };
}

// ---------------------------------------------------------------------------
// Per-user snapshot fetch — used by the /insights page card.
// ---------------------------------------------------------------------------

/**
 * Fetch and build TcCardSnapshot[] for a single user. Used by the /insights
 * page real-time card. Cards with no cupo AND no cutoff are excluded.
 *
 * @param userId   The authenticated user's id.
 * @param fxRate   Current COP/USD FX rate (from `getCurrentFxRate().rate`).
 * @param today    Bogota date (from `nowInBogota(new Date())`).
 */
export async function fetchUserTcSnapshots(
  userId: number,
  fxRate: number,
  today: BogotaYmd,
): Promise<TcCardSnapshot[]> {
  const [multiRows, singleRows] = await Promise.all([
    fetchMultiCurrencyCards(userId),
    fetchSingleCurrencyCards(userId),
  ]);

  const snapshots: TcCardSnapshot[] = [];

  for (const row of multiRows) {
    if (row.statementCutoffDay === null && row.creditLimitCents === BI_ZERO) continue;
    snapshots.push(buildMultiSnapshot(row, fxRate, today));
  }

  for (const row of singleRows) {
    const limitCents = BigInt(row.metadata.creditLimitCents ?? 0);
    const cutoffDay = row.metadata.cutoffDay ?? null;
    if (cutoffDay === null && limitCents === BI_ZERO) continue;
    snapshots.push(buildSingleSnapshot(row, fxRate, today));
  }

  return snapshots;
}

// Re-export nowInBogota so callers that only use this module don't need to
// import _shared separately.
export { nowInBogota };
