/**
 * TC health-check BullMQ worker.
 *
 * Runs daily at 08:00 America/Bogota. For every user, iterates their TCs
 * (both multi-currency `physical_cards` AND single-currency `accounts` with
 * `metadata.cutoffDay`) and emits `tc_health_alert` notifications when:
 *
 *   - Statement cutoff is ≤ 3 days away
 *   - Utilization ≥ 80% (highest crossed bucket: 80 / 90 / 95)
 *
 * Dedup is handled by `emitNotification`'s partial unique index on
 * (user_id, type, entity_id) WHERE read_at IS NULL, using the entityId
 * scheme `tc-alert-{cardId}-{yearMonth}-{trigger}`.
 *
 * The pure alert logic lives in `src/lib/insights/tc-health.ts` and is
 * shared with the `/insights` page real-time card.
 */

import type { Job } from "bullmq";
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { accounts, physicalCards, type AccountMetadata } from "@/lib/db/schema";
import { derivedBalanceCentsSql } from "@/lib/accounts/queries";
import { notDeleted } from "@/lib/db/helpers";
import { toCop } from "@/lib/money";
import { getCurrentFxRate } from "@/lib/fx/repo";
import { createLogger } from "@/lib/logger";
import { formatAccountLabel } from "@/lib/accounts/format";
import { emitNotification } from "@/lib/notifications/emit";
import { createWorker } from "@/lib/queue";
import { nowInBogota, roundUtilizationPct, type BogotaYmd } from "@/lib/widgets/handlers/_shared";
import { computeNextCutoff } from "@/lib/widgets/handlers/tc-focus";
import { computeTcAlerts, type TcCardSnapshot } from "@/lib/insights/tc-health";

const log = createLogger({ module: "worker/tc-health-check" });

export type TcHealthCheckJobData = Record<string, never>;

const BI_ZERO = BigInt(0);

// ---------------------------------------------------------------------------
// yearMonth helper (Bogota-anchored) — mirrors budget-check.ts pattern
// ---------------------------------------------------------------------------

/**
 * Returns the current yearMonth string in America/Bogota timezone.
 * Format: "YYYY-MM".
 */
export function getCurrentYearMonth(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
  })
    .format(new Date())
    .slice(0, 7); // "YYYY-MM"
}

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

type MultiCurrencyRow = {
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

type SingleCurrencyRow = {
  id: number;
  name: string;
  institution: string;
  currency: "COP" | "USD";
  metadata: AccountMetadata;
  userId: number;
  balanceCents: bigint;
};

// ---------------------------------------------------------------------------
// Queries — two round-trips for the whole tenant roster, not N+1.
// Mirrors fetchMultiCurrencyCards / fetchSingleCurrencyCards from mis-tcs.ts.
// ---------------------------------------------------------------------------

async function fetchMultiCurrencyCards(userId?: number): Promise<MultiCurrencyRow[]> {
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

async function fetchSingleCurrencyCards(userId?: number): Promise<SingleCurrencyRow[]> {
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

function buildMultiSnapshot(
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
    creditLimitCents: row.creditLimitCents,
    usedCents: usedClamped,
    utilizationPct,
    daysToCutoff,
  };
}

function buildSingleSnapshot(
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
    creditLimitCents: limitNativeCents,
    usedCents: usedNativeCents,
    utilizationPct,
    daysToCutoff,
  };
}

// ---------------------------------------------------------------------------
// Per-user snapshot fetch — used by the /insights page card.
// Mirrors the cron logic but scoped to a single userId and driven by the
// caller-supplied fxRate (the page already has it in scope).
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

// ---------------------------------------------------------------------------
// Core processor — exported for testability
// ---------------------------------------------------------------------------

export async function tcHealthCheckProcessor(job: Job<TcHealthCheckJobData>): Promise<void> {
  const yearMonth = getCurrentYearMonth();
  const now = new Date();
  const today = nowInBogota(now);

  log.info({ event: "tc_health_check_start", jobId: job.id, yearMonth }, "tc-health-check started");

  await job.updateProgress({ phase: "fetching", yearMonth });
  await job.log(`start: tc-health-check for ${yearMonth}`);

  const [multiRows, singleRows] = await Promise.all([
    fetchMultiCurrencyCards(),
    fetchSingleCurrencyCards(),
  ]);

  // Only fetch FX when needed (multi-currency cards with USD exposure)
  const needsFx =
    multiRows.some((r) => r.usdDebtCents !== BI_ZERO) ||
    singleRows.some((r) => r.currency === "USD");
  const fxRate = needsFx ? (await getCurrentFxRate()).rate : 0;

  // Build snapshots and group by userId for logging
  const snapsByUser = new Map<number, TcCardSnapshot[]>();

  for (const row of multiRows) {
    // Skip if cutoffDay is null AND creditLimitCents is 0 — nothing to alert on
    if (row.statementCutoffDay === null && row.creditLimitCents === BI_ZERO) continue;
    const snap = buildMultiSnapshot(row, fxRate, today);
    const existing = snapsByUser.get(row.userId) ?? [];
    existing.push(snap);
    snapsByUser.set(row.userId, existing);
  }

  for (const row of singleRows) {
    const limitCents = BigInt(row.metadata.creditLimitCents ?? 0);
    const cutoffDay = row.metadata.cutoffDay ?? null;
    // Skip if cutoffDay is null AND creditLimitCents is 0
    if (cutoffDay === null && limitCents === BI_ZERO) continue;
    const snap = buildSingleSnapshot(row, fxRate, today);
    const existing = snapsByUser.get(row.userId) ?? [];
    existing.push(snap);
    snapsByUser.set(row.userId, existing);
  }

  log.info(
    {
      event: "tc_health_check_fetched",
      userCount: snapsByUser.size,
      multiCount: multiRows.length,
      singleCount: singleRows.length,
      jobId: job.id,
    },
    `found ${snapsByUser.size} user(s) with TC(s)`,
  );

  let totalEmitted = 0;
  let totalDeduped = 0;

  for (const [userId, snaps] of snapsByUser) {
    for (const snap of snaps) {
      const triggers = computeTcAlerts(snap);
      if (triggers.length === 0) continue;

      for (const trigger of triggers) {
        const entityId = `tc-alert-${snap.cardId}-${yearMonth}-${trigger}`;

        const { title, body } = buildNotificationText(snap, trigger);

        try {
          const result = await emitNotification(userId, {
            type: "tc_health_alert",
            entityId,
            priority: "medium",
            title,
            body,
            actionUrl: "/insights",
            metadata: {
              cardId: snap.cardId,
              kind: snap.kind,
              trigger,
              yearMonth,
              utilizationPct: snap.utilizationPct,
              daysToCutoff: snap.daysToCutoff,
              creditLimitCents: snap.creditLimitCents.toString(),
              usedCents: snap.usedCents.toString(),
            },
          });

          if (result === null) {
            totalDeduped++;
            log.debug(
              { userId, entityId, event: "tc_health_alert_dedup" },
              "tc_health_alert deduped",
            );
          } else {
            totalEmitted++;
            log.info(
              {
                userId,
                cardId: snap.cardId,
                trigger,
                yearMonth,
                entityId,
                notificationId: result.id,
                event: "tc_health_alert_emitted",
              },
              "tc_health_alert notification emitted",
            );
          }
        } catch (err) {
          // Per-card failures are logged but never abort the loop — other users
          // must still get their notifications even if one emit fails.
          log.error(
            {
              err,
              userId,
              cardId: snap.cardId,
              trigger,
              entityId,
              event: "tc_health_alert_emit_failed",
            },
            "tc_health_alert emit failed",
          );
        }
      }
    }
  }

  await job.updateProgress({ done: true, emitted: totalEmitted, deduped: totalDeduped });
  await job.log(`done: yearMonth=${yearMonth} emitted=${totalEmitted} deduped=${totalDeduped}`);

  log.info(
    {
      event: "tc_health_check_done",
      yearMonth,
      emitted: totalEmitted,
      deduped: totalDeduped,
      jobId: job.id,
    },
    "tc-health-check complete",
  );
}

// ---------------------------------------------------------------------------
// Notification text builders
// ---------------------------------------------------------------------------

function buildNotificationText(
  snap: TcCardSnapshot,
  trigger: string,
): { title: string; body: string } {
  if (trigger === "statement") {
    const days = snap.daysToCutoff!;
    const when = days === 0 ? "hoy" : days === 1 ? "mañana" : `en ${days} días`;
    return {
      title: `${snap.label}: corte ${when}`,
      body: `El corte de tu tarjeta cae ${when}. Revisá tu saldo.`,
    };
  }

  const pct = snap.utilizationPct;
  const tier = trigger === "util-95" ? "95%" : trigger === "util-90" ? "90%" : "80%";
  return {
    title: `${snap.label}: cupo al ${pct}%`,
    body: `Tenés el ${pct}% del cupo usado — llegaste al umbral del ${tier}.`,
  };
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

export function createTcHealthCheckWorker() {
  return createWorker<TcHealthCheckJobData, void>(
    "tc-health-check",
    async (job) => {
      try {
        await tcHealthCheckProcessor(job);
      } catch (err) {
        log.error(
          { err, event: "tc_health_check_fanout_failed", jobId: job.id },
          "tc-health-check processor threw — BullMQ will retry",
        );
        throw err;
      }
    },
    {
      concurrency: 1,
    },
  );
}
