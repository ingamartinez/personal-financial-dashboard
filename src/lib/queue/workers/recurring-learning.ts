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
// Idempotency: duplicate proposals (same recurring + type with status='pending')
// are skipped to avoid flooding the user.

import type { Job } from "bullmq";
import { and, eq, lte, sql } from "drizzle-orm";

import { createLogger } from "@/lib/logger";
import { db } from "@/lib/db";
import { recurringProposals } from "@/lib/db/schema";
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

export type LearningResult = {
  usersProcessed: number;
  proposalsCreated: number;
  errors: number;
};

/**
 * Core processor — exported separately for tests (no live Worker needed).
 */
export async function recurringLearningProcessor(
  job: Job<RecurringLearningJobData>,
): Promise<LearningResult> {
  log.info({ event: "recurring_learning_start", jobId: job.id }, "recurring-learning started");

  const result: LearningResult = { usersProcessed: 0, proposalsCreated: 0, errors: 0 };

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

    usersSeen.add(userId);

    try {
      // Wrap SELECT + INSERT in a transaction to prevent race conditions from
      // a manual Bull-Board trigger racing with the scheduled daily run.
      const created = await db.transaction(async (trx) => {
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
          return 0;
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

          await trx.insert(recurringProposals).values({
            userId,
            recurringId,
            proposalType: "variable_flag",
            payload,
          });

          log.info(
            {
              event: "recurring_learning_proposal_variable",
              userId,
              recurringId,
              obsCount,
              distinctAmountsCount: distinctAmounts.length,
            },
            "variable_flag proposal created",
          );

          return 1;
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
          if (absEst === 0) return 0;

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

            await trx.insert(recurringProposals).values({
              userId,
              recurringId,
              proposalType: "amount_update",
              payload,
            });

            log.info(
              {
                event: "recurring_learning_proposal_amount",
                userId,
                recurringId,
                estimatedAmount: estimatedAmount.toString(),
                newAmount: newAmount.toString(),
                driftPct: Math.round(drift * 100),
                obsCount,
              },
              "amount_update proposal created",
            );

            return 1;
          }
        }

        return 0;
      });

      result.proposalsCreated += created;
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

  result.usersProcessed = usersSeen.size;

  log.info(
    {
      event: "recurring_learning_done",
      jobId: job.id,
      usersProcessed: result.usersProcessed,
      proposalsCreated: result.proposalsCreated,
      errors: result.errors,
    },
    "recurring-learning complete",
  );

  return result;
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
