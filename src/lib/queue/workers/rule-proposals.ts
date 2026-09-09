// #667 + #814 5d: rule-proposals BullMQ worker.
// Runs daily at 05:00 America/Bogota. Scans classification_corrections for
// (user, merchant, category) groups with 3+ corrections in the last 30 days,
// inserts pending rule_proposals, then asks the AI to write generalizing
// ILIKE patterns (never auto-applied). Emits a rule_proposal_ready
// notification per inserted proposal.

import type { Job } from "bullmq";

import { createLogger } from "@/lib/logger";
import { detectAndEnqueueRuleProposals } from "@/lib/classification/proposals";
import { synthesizeRuleProposals } from "@/lib/classification/synthesize-rules";
import { emitNotification } from "@/lib/notifications/emit";
import { createWorker } from "@/lib/queue";

const log = createLogger({ module: "worker/rule-proposals" });

export type RuleProposalsJobData = Record<string, never>;

export type RuleProposalsResult = {
  scanned: number;
  inserted: number;
  skipped: number;
  emitted: number;
  synthesized: number;
};

/**
 * Core processor — exported separately for tests (no live Worker needed).
 */
export async function ruleProposalsProcessor(
  job: Job<RuleProposalsJobData>,
): Promise<RuleProposalsResult> {
  log.info({ event: "rule_proposals_start", jobId: job.id }, "rule-proposals started");

  await job.updateProgress({ phase: "detecting" });
  await job.log("start: detecting and enqueuing rule proposals");

  const result = await detectAndEnqueueRuleProposals();

  await job.updateProgress({ phase: "synthesizing" });
  await job.log("start: synthesizing generalizing ILIKE proposals");

  // Synthesis must not fail the correction path. A model timeout still leaves
  // the 3× merchant proposals in place.
  let synthesized: { inserted: number; skipped: number; proposals: typeof result.proposals } = {
    inserted: 0,
    skipped: 0,
    proposals: [],
  };
  try {
    synthesized = await synthesizeRuleProposals();
  } catch (err) {
    log.error(
      { err, event: "rule_synthesis_failed", jobId: job.id },
      "rule synthesis failed — correction proposals still stand",
    );
  }

  const proposals = [...result.proposals, ...synthesized.proposals];

  log.info(
    {
      event: "rule_proposals_run",
      scanned: result.scanned,
      inserted: result.inserted,
      skipped: result.skipped,
      synthesized: synthesized.inserted,
      proposalsEmitted: proposals.length,
    },
    "rule proposals run",
  );

  await job.log(
    `detected: scanned=${result.scanned} inserted=${result.inserted} skipped=${result.skipped} synthesized=${synthesized.inserted}`,
  );
  await job.updateProgress({ phase: "emitting", proposals: proposals.length });

  // Emit one rule_proposal_ready notification per inserted proposal.
  // Fire-and-forget with per-proposal error handling — a failed notification
  // must NOT abort the overall result.
  const emitResults = await Promise.allSettled(
    proposals.map((proposal) =>
      emitNotification(proposal.userId, {
        type: "rule_proposal_ready",
        entityId: String(proposal.id),
        priority: "medium",
        title: "Nueva regla sugerida",
        body:
          proposal.source === "synthesized"
            ? `La IA sugiere una regla: ${proposal.pattern} → ${proposal.categorySlug}. Revisá el alcance antes de aprobar.`
            : `Detectamos un patrón en tus correcciones: ${proposal.merchant} → ${proposal.categorySlug}. Revisá si querés convertirlo en regla.`,
        actionUrl: "/settings/rules/proposals",
        metadata: {
          proposalId: proposal.id,
          merchant: proposal.merchant,
          pattern: proposal.pattern,
          categorySlug: proposal.categorySlug,
          source: proposal.source,
        },
      }),
    ),
  );

  let emitted = 0;
  for (let i = 0; i < emitResults.length; i++) {
    const settledResult = emitResults[i]!;
    const proposal = proposals[i]!;
    if (settledResult.status === "rejected") {
      log.error(
        {
          err: settledResult.reason,
          proposalId: proposal.id,
          userId: proposal.userId,
          event: "rule_proposal_emit_failed",
        },
        "rule_proposal_ready emit failed",
      );
    } else {
      emitted++;
      log.info(
        {
          event: "rule_proposal_notification_emitted",
          userId: proposal.userId,
          proposalId: proposal.id,
          merchant: proposal.merchant,
          categorySlug: proposal.categorySlug,
        },
        "rule_proposal_ready notification emitted",
      );
    }
  }

  const summary: RuleProposalsResult = {
    scanned: result.scanned,
    inserted: result.inserted,
    skipped: result.skipped,
    emitted,
    synthesized: synthesized.inserted,
  };

  await job.updateProgress({ done: true, ...summary });
  await job.log(
    `done: scanned=${summary.scanned} inserted=${summary.inserted} skipped=${summary.skipped} emitted=${summary.emitted}`,
  );

  log.info({ event: "rule_proposals_done", jobId: job.id, ...summary }, "rule-proposals complete");

  return summary;
}

/**
 * Create and register the rule-proposals BullMQ worker.
 * Concurrency 1 — single daily run processes all users in one CTE batch.
 */
export function createRuleProposalsWorker() {
  return createWorker<RuleProposalsJobData, RuleProposalsResult>(
    "rule-proposals",
    async (job) => {
      try {
        return await ruleProposalsProcessor(job);
      } catch (err) {
        log.error(
          { err, event: "rule_proposals_fanout_failed", jobId: job.id },
          "rule-proposals processor threw — BullMQ will retry",
        );
        throw err;
      }
    },
    {
      concurrency: 1,
    },
  );
}
