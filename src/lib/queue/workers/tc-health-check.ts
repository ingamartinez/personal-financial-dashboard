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
 *
 * DB helpers and snapshot builders live in
 * `src/lib/insights/tc-health-queries.ts` so the /insights page can import
 * them without pulling BullMQ / ioredis into the RSC route module graph.
 */

import type { Job } from "bullmq";

import { getCurrentFxRate } from "@/lib/fx/repo";
import { createLogger } from "@/lib/logger";
import { formatMoney } from "@/lib/money";
import { emitNotification } from "@/lib/notifications/emit";
import { createWorker } from "@/lib/queue";
import { nowInBogota } from "@/lib/widgets/handlers/_shared";
import { computeTcAlerts, type TcCardSnapshot } from "@/lib/insights/tc-health";
import {
  fetchMultiCurrencyCards,
  fetchSingleCurrencyCards,
  buildMultiSnapshot,
  buildSingleSnapshot,
} from "@/lib/insights/tc-health-queries";

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
  let body = `Tenés el ${pct}% del cupo usado — llegaste al umbral del ${tier}.`;

  // Payment suggestion: how much to pay to get back to 70% utilization
  const targetCents = (snap.creditLimitCents * BigInt(70)) / BigInt(100);
  const paymentNeeded = snap.usedCents - targetCents;
  if (paymentNeeded > BI_ZERO) {
    body += ` Pagá ${formatMoney(paymentNeeded, snap.currency)} para bajar al 70%.`;
  }

  return {
    title: `${snap.label}: cupo al ${pct}%`,
    body,
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
