// #633: recurring-learning BullMQ worker.
// Runs daily at 04:00 America/Bogota. Scans recurring_link_observations where
// manual=true and applied=false, groups by (user_id, recurring_id), and writes
// proposals to recurring_proposals.
//
// Two proposal types:
//   - amount_update: N≥2 consecutive manual observations all showing the SAME
//     real_amount_cents that differs from recurring.amount_cents by >5%
//     (and same currency). Proposes updating the recurring estimate.
//   - variable_flag: N≥3 manual observations showing non-uniform real amounts.
//     Proposes setting amount_type='variable' and stops firing amount proposals.
//
// #871 B: after proposals, active variable recurrings get amount_cents
// rewritten to the median of the last 3 same-currency observations. Silent —
// no proposal, no notification.
//
// #871 C: variable recurrings then run through detectAmountOutlier. A hit
// becomes an amount_outlier proposal ("nuevo normal" vs "fue puntual").
//
// Idempotency: duplicate proposals (same recurring + type with status='pending')
// are skipped to avoid flooding the user.

import type { Job } from "bullmq";
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";

import { createLogger } from "@/lib/logger";
import { db } from "@/lib/db";
import {
  recurringLinkObservations,
  recurringProposals,
  recurringTransactions,
} from "@/lib/db/schema";
import { medianOfLast3SameCurrency } from "@/lib/insights/cash-flow";
import { detectAmountOutlier } from "@/lib/recurring/amount-outlier-detector";
import type { Currency } from "@/lib/types";
import { emitNotification } from "@/lib/notifications/emit";
import { createWorker } from "@/lib/queue";

const log = createLogger({ module: "worker/recurring-learning" });

export type RecurringLearningJobData = Record<string, never>;

// Threshold: real amount must differ from estimated by more than this fraction
// before we propose an update. 5% — small enough to catch Netflix price bumps
// ($42.000 → $44.900 ≈ 7%), big enough to ignore FX rounding noise.
const AMOUNT_DRIFT_THRESHOLD = 0.05;

// Minimum observations needed to propose an amount update.
const MIN_OBSERVATIONS_FOR_AMOUNT_UPDATE = 2;

// Minimum observations needed to flag a recurring as variable.
const MIN_OBSERVATIONS_FOR_VARIABLE_FLAG = 3;

export type AmountUpdatePayload = {
  newAmountCents: string; // bigint serialized
  oldAmountCents: string; // bigint serialized
  currency: string;
  observationCount: number;
};

export type VariableFlagPayload = {
  detectedAmounts: string[]; // distinct amounts (bigint serialized)
  currency: string;
  observationCount: number;
};

export type AmountOutlierPayload = {
  observationId: number;
  outlierAmountCents: string;
  bandMinCents: string;
  bandMaxCents: string;
  currency: string;
  observationCount: number;
};

export type LearningResult = {
  usersProcessed: number;
  proposalsCreated: number;
  errors: number;
  variableEstimatesUpdated: number;
};

type ProposalOutcome =
  | { count: 0 }
  | {
      count: 1;
      proposalId: number;
      proposalKind: "variable_flag" | "amount_update" | "amount_outlier";
    };

/**
 * Core processor — exported separately for tests (no live Worker needed).
 */
export async function recurringLearningProcessor(
  job: Job<RecurringLearningJobData>,
): Promise<LearningResult> {
  log.info({ event: "recurring_learning_start", jobId: job.id }, "recurring-learning started");

  await job.updateProgress({ users: 0, total: 0 });
  await job.log("start: expiring stale proposals + scanning observations");

  const result: LearningResult = {
    usersProcessed: 0,
    proposalsCreated: 0,
    errors: 0,
    variableEstimatesUpdated: 0,
  };

  // Step 0: expire pending proposals older than 30 days BEFORE generating new ones.
  // This is a global sweep (all users), idempotent on retry — runs outside per-row tx.
  const cutoff = new Date(Date.now() - 30 * 86400000);
  const expired = await db
    .update(recurringProposals)
    .set({ status: "expired", decidedAt: new Date() })
    .where(and(eq(recurringProposals.status, "pending"), lte(recurringProposals.createdAt, cutoff)))
    .returning({ id: recurringProposals.id });
  log.info(
    { event: "recurring_learning_expired", count: expired.length },
    "expired stale pending proposals",
  );
  await job.log(`expired: stale proposals expired=${expired.length}`);

  // Step 0b (#870): expire pending amount_update proposals that are already
  // stale, REGARDLESS OF AGE — deliberately not folded into the 30-day
  // cutoff above. Either the recurring's currency has since diverged from
  // the currency the proposal was computed in (recurring migrated
  // USD -> COP after the worker ran), or newAmountCents already equals the
  // recurring's current estimate (accepting would be a no-op). A proposal
  // already known to be wrong or redundant shouldn't sit pending for up to
  // 30 days waiting on the age-based sweep — expire it the moment this
  // worker run can prove it's stale. Scoped to amount_update —
  // variable_flag proposals carry no such staleness.
  //
  // IS NOT NULL guards: a payload missing `currency` or `newAmountCents`
  // makes its OR-branch evaluate to NULL/false, so the row is left
  // untouched (not errored, not force-expired) — see
  // recurring-learning.test.ts's "malformed payload" coverage.
  const staleExpired = await db.execute<{ id: number }>(sql`
    UPDATE recurring_proposals rp
    SET status = 'expired', decided_at = NOW()
    FROM recurring_transactions rt
    WHERE rp.recurring_id = rt.id
      AND rp.user_id = rt.user_id
      AND rp.status = 'pending'
      AND rp.proposal_type = 'amount_update'
      AND rt.deleted_at IS NULL
      AND (
        (
          rp.payload->>'currency' IS NOT NULL
          AND rp.payload->>'currency' <> rt.currency::text
        )
        OR (
          rp.payload->>'newAmountCents' IS NOT NULL
          AND (rp.payload->>'newAmountCents')::bigint = rt.amount_cents
        )
      )
    RETURNING rp.id
  `);
  log.info(
    { event: "recurring_learning_stale_expired", count: staleExpired.length },
    "expired stale amount_update proposals (currency mismatch or no-op)",
  );
  await job.log(`expired: stale amount_update proposals expired=${staleExpired.length}`);

  // Step 1a (#870): surface — but never aggregate — observation groups whose
  // real_currency disagrees with the recurring's current currency. This is a
  // data problem (a COP recurring re-pointed at a USD account, or vice
  // versa), not something the worker should paper over by drift-comparing
  // across currencies (that's what produced the nonsense proposals in #870).
  const mismatched = await db.execute<{
    user_id: number;
    recurring_id: number;
    observed_currency: string;
    recurring_currency: string;
    obs_count: number;
  }>(sql`
    SELECT
      obs.user_id,
      obs.recurring_id,
      obs.real_currency AS observed_currency,
      rt.currency AS recurring_currency,
      COUNT(*)::int AS obs_count
    FROM recurring_link_observations obs
    INNER JOIN recurring_transactions rt
      ON rt.id = obs.recurring_id
      AND rt.user_id = obs.user_id
    WHERE
      obs.manual = true
      AND obs.applied = false
      AND rt.deleted_at IS NULL
      AND rt.active = true
      AND rt.amount_type != 'variable'
      AND obs.real_currency != rt.currency
    GROUP BY obs.user_id, obs.recurring_id, obs.real_currency, rt.currency
  `);

  for (const row of mismatched) {
    log.warn(
      {
        event: "recurring_learning_currency_mismatch_skipped",
        userId: Number(row.user_id),
        recurringId: Number(row.recurring_id),
        observedCurrency: row.observed_currency,
        recurringCurrency: row.recurring_currency,
        obsCount: Number(row.obs_count),
      },
      "skipped observation group — real_currency disagrees with the recurring's currency (data problem, not a bug)",
    );
  }

  // Step 1: find all (user_id, recurring_id) pairs with unapplied manual observations.
  // We use a raw SQL aggregation to get per-group stats efficiently.
  const groups = await db.execute<{
    user_id: number;
    recurring_id: number;
    obs_count: number;
    amounts: string; // JSON array of distinct amount_cents strings
    currency: string;
    estimated_amount: bigint;
    amount_type: string;
  }>(sql`
    SELECT
      obs.user_id,
      obs.recurring_id,
      COUNT(*)::int AS obs_count,
      JSON_AGG(DISTINCT obs.real_amount_cents::text ORDER BY obs.real_amount_cents::text) AS amounts,
      obs.real_currency AS currency,
      rt.amount_cents AS estimated_amount,
      rt.amount_type
    FROM recurring_link_observations obs
    INNER JOIN recurring_transactions rt
      ON rt.id = obs.recurring_id
      AND rt.user_id = obs.user_id
    WHERE
      obs.manual = true
      AND obs.applied = false
      AND rt.deleted_at IS NULL
      AND rt.active = true
      AND rt.amount_type != 'variable'
      -- #870: same-currency guard — an observation recorded in a different
      -- currency than the recurring's current currency must never be
      -- drift-compared against rt.amount_cents (see mismatch query above).
      AND obs.real_currency = rt.currency
    GROUP BY obs.user_id, obs.recurring_id, obs.real_currency, rt.amount_cents, rt.amount_type
  `);

  // Track unique users for telemetry.
  const usersSeen = new Set<number>();

  for (const row of groups) {
    const userId = Number(row.user_id);
    const recurringId = Number(row.recurring_id);
    const obsCount = Number(row.obs_count);
    const estimatedAmount = BigInt(row.estimated_amount);
    const currency = row.currency;

    // amounts comes back as a JSON array of strings.
    let amounts: bigint[];
    try {
      const parsed: string[] =
        typeof row.amounts === "string" ? JSON.parse(row.amounts) : row.amounts;
      amounts = parsed.map((a) => BigInt(a));
    } catch {
      log.error(
        { event: "recurring_learning_parse_error", userId, recurringId, amounts: row.amounts },
        "failed to parse amounts from observation group",
      );
      result.errors++;
      continue;
    }

    const isNewUser = !usersSeen.has(userId);
    usersSeen.add(userId);

    if (isNewUser) {
      await job.updateProgress({
        users: usersSeen.size,
        total: groups.length,
        proposals: result.proposalsCreated,
      });
    }

    try {
      // Wrap SELECT + INSERT in a transaction to prevent race conditions from
      // a manual Bull-Board trigger racing with the scheduled daily run.
      const outcome = await db.transaction(async (trx): Promise<ProposalOutcome> => {
        // Check for an existing pending proposal of any type for this recurring.
        const [existingPending] = await trx
          .select({ id: recurringProposals.id })
          .from(recurringProposals)
          .where(
            and(
              eq(recurringProposals.userId, userId),
              eq(recurringProposals.recurringId, recurringId),
              eq(recurringProposals.status, "pending"),
            ),
          )
          .limit(1);

        if (existingPending) {
          // A proposal is already pending — skip until user decides.
          return { count: 0 };
        }

        const distinctAmounts = [...new Set(amounts.map((a) => a.toString()))].map((s) =>
          BigInt(s),
        );

        // ── Variable-flag check ─────────────────────────────────────────────
        // N≥3 observations with >1 distinct amount → flag as variable.
        if (obsCount >= MIN_OBSERVATIONS_FOR_VARIABLE_FLAG && distinctAmounts.length > 1) {
          const payload: VariableFlagPayload = {
            detectedAmounts: distinctAmounts.map((a) => a.toString()),
            currency,
            observationCount: obsCount,
          };

          const [inserted] = await trx
            .insert(recurringProposals)
            .values({
              userId,
              recurringId,
              proposalType: "variable_flag",
              payload,
            })
            .returning({ id: recurringProposals.id });

          log.info(
            {
              event: "recurring_learning_proposal_variable",
              userId,
              recurringId,
              obsCount,
              distinctAmountsCount: distinctAmounts.length,
              proposalId: inserted?.id,
            },
            "variable_flag proposal created",
          );

          return { count: 1, proposalId: inserted!.id, proposalKind: "variable_flag" };
        }

        // ── Amount-update check ─────────────────────────────────────────────
        // N≥2 observations all showing the SAME amount that differs by >5%.
        if (obsCount >= MIN_OBSERVATIONS_FOR_AMOUNT_UPDATE && distinctAmounts.length === 1) {
          const newAmount = distinctAmounts[0];

          // Sign-convention: amounts are signed (negative for expenses).
          // Compare magnitudes with Math.abs to handle the sign correctly.
          // Use Number() for comparisons since ES2017 target bans BigInt literals (0n).
          const newAmountNum = Number(newAmount);
          const estimatedAmountNum = Number(estimatedAmount);
          const absNew = Math.abs(newAmountNum);
          const absEst = Math.abs(estimatedAmountNum);

          // Avoid divide-by-zero for zero-amount recurrings.
          if (absEst === 0) return { count: 0 };

          // Express drift as a fraction. Using Number() is safe here — we only
          // need a rough 5% comparison, not bigint precision.
          const drift = Math.abs(absNew - absEst) / absEst;

          if (drift > AMOUNT_DRIFT_THRESHOLD) {
            const payload: AmountUpdatePayload = {
              newAmountCents: newAmount.toString(),
              oldAmountCents: estimatedAmount.toString(),
              currency,
              observationCount: obsCount,
            };

            const [inserted] = await trx
              .insert(recurringProposals)
              .values({
                userId,
                recurringId,
                proposalType: "amount_update",
                payload,
              })
              .returning({ id: recurringProposals.id });

            log.info(
              {
                event: "recurring_learning_proposal_amount",
                userId,
                recurringId,
                estimatedAmount: estimatedAmount.toString(),
                newAmount: newAmount.toString(),
                driftPct: Math.round(drift * 100),
                obsCount,
                proposalId: inserted?.id,
              },
              "amount_update proposal created",
            );

            return { count: 1, proposalId: inserted!.id, proposalKind: "amount_update" };
          }
        }

        return { count: 0 };
      });

      result.proposalsCreated += outcome.count;

      // Emit notification if a proposal was created.
      if (outcome.count === 1) {
        // Fetch the recurring label for the notification body.
        const [recurring] = await db
          .select({ label: recurringTransactions.label })
          .from(recurringTransactions)
          .where(eq(recurringTransactions.id, recurringId))
          .limit(1);

        await emitNotification(userId, {
          type: "recurring_proposal_ready",
          entityId: String(outcome.proposalId),
          priority: "medium",
          title: "Sugerencia para recurrente",
          body: `Detectamos un patrón nuevo en ${recurring?.label ?? "un recurrente"}. Revisá la propuesta.`,
          actionUrl: "/recurring",
          metadata: {
            proposalId: outcome.proposalId,
            recurringId,
            proposalKind: outcome.proposalKind,
          },
        });

        log.info(
          {
            event: "recurring_proposal_notification_emitted",
            userId,
            recurringId,
            proposalId: outcome.proposalId,
            proposalKind: outcome.proposalKind,
          },
          "recurring_proposal_ready notification emitted",
        );
      }
    } catch (err) {
      log.error(
        {
          err,
          event: "recurring_learning_group_failed",
          userId,
          recurringId,
        },
        "error processing recurring learning group — continuing",
      );
      result.errors++;
    }
  }

  // #871 B: silently recompute amount_cents for variable recurrings from the
  // median of the last 3 same-currency observations. Accepting variable_flag
  // already told us to stop asking — writing the median is arithmetic, not a
  // judgment. No proposal, no notification.
  await recomputeVariableEstimates(result);
  await detectVariableOutliers(result);

  result.usersProcessed = usersSeen.size;

  log.info(
    {
      event: "recurring_learning_done",
      jobId: job.id,
      usersProcessed: result.usersProcessed,
      proposalsCreated: result.proposalsCreated,
      variableEstimatesUpdated: result.variableEstimatesUpdated,
      errors: result.errors,
    },
    "recurring-learning complete",
  );

  await job.updateProgress({
    done: true,
    proposalsGenerated: result.proposalsCreated,
    variableEstimatesUpdated: result.variableEstimatesUpdated,
    totalUsers: result.usersProcessed,
  });
  await job.log(
    `done: users=${result.usersProcessed} proposals=${result.proposalsCreated} variableEstimates=${result.variableEstimatesUpdated} errors=${result.errors}`,
  );

  return result;
}

/**
 * #871 B: write median-of-last-3 onto every active variable recurring.
 * Isolated so the proposal loop stays untouched. Failures on one row do
 * not abort the rest — same continue-on-error contract as the group loop.
 */
async function recomputeVariableEstimates(result: LearningResult): Promise<void> {
  const variableRecurrings = await db
    .select({
      id: recurringTransactions.id,
      userId: recurringTransactions.userId,
      currency: recurringTransactions.currency,
      amountCents: recurringTransactions.amountCents,
    })
    .from(recurringTransactions)
    .where(
      and(
        isNull(recurringTransactions.deletedAt),
        eq(recurringTransactions.active, true),
        eq(recurringTransactions.amountType, "variable"),
      ),
    );

  if (variableRecurrings.length === 0) return;

  const ids = variableRecurrings.map((r) => r.id);
  const obsRows = await db
    .select({
      recurringId: recurringLinkObservations.recurringId,
      realAmountCents: recurringLinkObservations.realAmountCents,
      realCurrency: recurringLinkObservations.realCurrency,
      observedAt: recurringLinkObservations.observedAt,
    })
    .from(recurringLinkObservations)
    .innerJoin(
      recurringTransactions,
      and(
        eq(recurringTransactions.id, recurringLinkObservations.recurringId),
        eq(recurringTransactions.userId, recurringLinkObservations.userId),
      ),
    )
    .where(
      and(
        inArray(recurringLinkObservations.recurringId, ids),
        isNull(recurringLinkObservations.excludedAt),
      ),
    );

  const obsByRecurring = new Map<
    number,
    { realAmountCents: bigint; realCurrency: string; observedAt: Date }[]
  >();
  for (const row of obsRows) {
    const list = obsByRecurring.get(row.recurringId) ?? [];
    list.push({
      realAmountCents: BigInt(row.realAmountCents),
      realCurrency: row.realCurrency,
      observedAt: row.observedAt,
    });
    obsByRecurring.set(row.recurringId, list);
  }

  for (const rt of variableRecurrings) {
    const median = medianOfLast3SameCurrency(obsByRecurring.get(rt.id) ?? [], rt.currency);
    if (median === null) continue;
    if (median === rt.amountCents) continue;

    try {
      await db
        .update(recurringTransactions)
        .set({ amountCents: median })
        .where(
          and(
            eq(recurringTransactions.id, rt.id),
            eq(recurringTransactions.userId, rt.userId),
            isNull(recurringTransactions.deletedAt),
            eq(recurringTransactions.amountType, "variable"),
          ),
        );

      result.variableEstimatesUpdated++;
      log.info(
        {
          event: "recurring_learning_variable_estimate_updated",
          userId: rt.userId,
          recurringId: rt.id,
          oldAmountCents: rt.amountCents.toString(),
          newAmountCents: median.toString(),
        },
        "variable recurring estimate recomputed from median of last 3",
      );
    } catch (err) {
      log.error(
        {
          err,
          event: "recurring_learning_variable_estimate_failed",
          userId: rt.userId,
          recurringId: rt.id,
        },
        "error recomputing variable estimate — continuing",
      );
      result.errors++;
    }
  }
}

/**
 * #871 C: propose amount_outlier for variable recurrings whose latest
 * observation sits outside their own dispersion band. Caller (this worker)
 * pre-filters amount_type=variable; the detector itself is amountType-blind.
 */
async function detectVariableOutliers(result: LearningResult): Promise<void> {
  const variableRecurrings = await db
    .select({
      id: recurringTransactions.id,
      userId: recurringTransactions.userId,
      currency: recurringTransactions.currency,
      label: recurringTransactions.label,
    })
    .from(recurringTransactions)
    .where(
      and(
        isNull(recurringTransactions.deletedAt),
        eq(recurringTransactions.active, true),
        eq(recurringTransactions.amountType, "variable"),
      ),
    );

  if (variableRecurrings.length === 0) return;

  const ids = variableRecurrings.map((r) => r.id);
  const userIds = [...new Set(variableRecurrings.map((r) => r.userId))];
  const obsRows = await db
    .select({
      id: recurringLinkObservations.id,
      recurringId: recurringLinkObservations.recurringId,
      realAmountCents: recurringLinkObservations.realAmountCents,
      realCurrency: recurringLinkObservations.realCurrency,
      observedAt: recurringLinkObservations.observedAt,
    })
    .from(recurringLinkObservations)
    .innerJoin(
      recurringTransactions,
      and(
        eq(recurringTransactions.id, recurringLinkObservations.recurringId),
        eq(recurringTransactions.userId, recurringLinkObservations.userId),
      ),
    )
    .where(
      and(
        inArray(recurringLinkObservations.recurringId, ids),
        isNull(recurringLinkObservations.excludedAt),
      ),
    );

  const grouped = new Map<number, typeof obsRows>();
  for (const row of obsRows) {
    const list = grouped.get(row.recurringId) ?? [];
    list.push(row);
    grouped.set(row.recurringId, list);
  }

  const acceptedOutliers = await db
    .select({
      recurringId: recurringProposals.recurringId,
      payload: recurringProposals.payload,
    })
    .from(recurringProposals)
    .where(
      and(
        inArray(recurringProposals.recurringId, ids),
        inArray(recurringProposals.userId, userIds),
        eq(recurringProposals.proposalType, "amount_outlier"),
        eq(recurringProposals.status, "accepted"),
      ),
    );
  const decidedObsIds = new Set<number>();
  for (const row of acceptedOutliers) {
    const observationId = (row.payload as { observationId?: unknown }).observationId;
    if (typeof observationId === "number") decidedObsIds.add(observationId);
  }

  for (const rt of variableRecurrings) {
    const rows = grouped.get(rt.id) ?? [];
    const sameCurrency = rows
      .filter((o) => o.realCurrency === rt.currency)
      .sort((a, b) => {
        const dt = b.observedAt.getTime() - a.observedAt.getTime();
        if (dt !== 0) return dt;
        return b.id - a.id;
      })
      .map((o) => ({
        id: o.id,
        realAmountCents: BigInt(o.realAmountCents),
        observedAt: o.observedAt,
        realCurrency: o.realCurrency as Currency,
      }));

    const latest = sameCurrency[0];
    if (!latest || decidedObsIds.has(latest.id)) continue;

    const hit = detectAmountOutlier(rt.id, sameCurrency);
    if (!hit) continue;

    try {
      const outcome = await db.transaction(async (trx): Promise<ProposalOutcome> => {
        const [existingPending] = await trx
          .select({ id: recurringProposals.id })
          .from(recurringProposals)
          .where(
            and(
              eq(recurringProposals.userId, rt.userId),
              eq(recurringProposals.recurringId, rt.id),
              eq(recurringProposals.status, "pending"),
            ),
          )
          .limit(1);
        if (existingPending) return { count: 0 };

        const payload: AmountOutlierPayload = {
          observationId: hit.observationId,
          outlierAmountCents: hit.outlierAmountCents.toString(),
          bandMinCents: hit.bandMinCents.toString(),
          bandMaxCents: hit.bandMaxCents.toString(),
          currency: hit.currency,
          observationCount: hit.observationCount,
        };

        const [inserted] = await trx
          .insert(recurringProposals)
          .values({
            userId: rt.userId,
            recurringId: rt.id,
            proposalType: "amount_outlier",
            payload,
          })
          .returning({ id: recurringProposals.id });

        log.info(
          {
            event: "recurring_learning_proposal_outlier",
            userId: rt.userId,
            recurringId: rt.id,
            observationId: hit.observationId,
            proposalId: inserted?.id,
          },
          "amount_outlier proposal created",
        );

        return { count: 1, proposalId: inserted!.id, proposalKind: "amount_outlier" };
      });

      result.proposalsCreated += outcome.count;

      if (outcome.count === 1) {
        await emitNotification(rt.userId, {
          type: "recurring_proposal_ready",
          entityId: String(outcome.proposalId),
          priority: "medium",
          title: "Sugerencia para recurrente",
          body: `Detectamos un patrón nuevo en ${rt.label}. Revisá la propuesta.`,
          actionUrl: "/recurring",
          metadata: {
            proposalId: outcome.proposalId,
            recurringId: rt.id,
            proposalKind: outcome.proposalKind,
          },
        });
      }
    } catch (err) {
      log.error(
        {
          err,
          event: "recurring_learning_outlier_failed",
          userId: rt.userId,
          recurringId: rt.id,
        },
        "error detecting amount outlier — continuing",
      );
      result.errors++;
    }
  }
}

/**
 * Create and register the recurring-learning BullMQ worker.
 * Concurrency 1 — single daily run processes all users sequentially.
 */
export function createRecurringLearningWorker() {
  return createWorker<RecurringLearningJobData, LearningResult>(
    "recurring-learning",
    async (job) => {
      try {
        return await recurringLearningProcessor(job);
      } catch (err) {
        log.error(
          { err, event: "recurring_learning_fanout_failed", jobId: job.id },
          "recurring-learning processor threw — BullMQ will retry",
        );
        throw err;
      }
    },
    {
      concurrency: 1,
    },
  );
}
