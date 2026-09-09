// #814 Phase 4 + 5a: residue worker.
// Investigates leftover rows (bounded, one at a time) then sends at most one
// Telegram question per user. Never runs inside the sweep/pipeline classify
// loops — those only enqueue this job.

import type { Job } from "bullmq";

import { createLogger } from "@/lib/logger";
import { createWorker } from "@/lib/queue";
import type { ClassifyAskJobData } from "@/lib/classification/enqueue";
import { listActiveAskUserIds, processAskForUser } from "@/lib/classification/ask-user";
import {
  investigateResidueForUser,
  listResidueUserIds,
  type InvestigateResidueForUserResult,
} from "@/lib/classification/investigate";

const log = createLogger({ module: "worker/classify-ask" });

export type { ClassifyAskJobData };

export type ClassifyAskResult = {
  usersProcessed: number;
  asked: number;
  investigated: number;
  failedUserIds: number[];
};

function uniqueIds(ids: number[]): number[] {
  return [...new Set(ids)];
}

export async function classifyAskProcessor(
  job: Job<ClassifyAskJobData>,
): Promise<ClassifyAskResult> {
  const { mode } = job.data;
  log.info({ event: "classify_ask_start", mode, jobId: job.id }, "classify-ask started");

  const userIds =
    mode === "single-user"
      ? [job.data.userId]
      : uniqueIds([...(await listActiveAskUserIds()), ...(await listResidueUserIds())]);

  const result: ClassifyAskResult = {
    usersProcessed: 0,
    asked: 0,
    investigated: 0,
    failedUserIds: [],
  };

  for (const userId of userIds) {
    let investigated: InvestigateResidueForUserResult = {
      considered: 0,
      classified: 0,
      inconclusive: 0,
      capped: 0,
      overBudget: 0,
      skippedIneligible: 0,
    };
    // Investigation and ask are separate doors. A timeout on a residue row
    // must not swallow the Telegram question — that is how this feature
    // goes silent while every check stays green.
    try {
      investigated = await investigateResidueForUser(userId);
      result.investigated += investigated.classified;
    } catch (err) {
      log.error(
        { err, userId, event: "classify_ask_investigate_failed" },
        "classify-ask: investigation failed — still asking",
      );
    }

    try {
      const userResult = await processAskForUser(userId);
      result.usersProcessed++;
      if (userResult.askedTxId != null) result.asked++;
      await job.log(
        `userId=${userId} classified=${investigated.classified} askedTxId=${userResult.askedTxId ?? "-"} skipped=${userResult.skipped ?? "-"} expired=${userResult.expiredCount} requeued=${userResult.requeuedCount}`,
      );
    } catch (err) {
      result.failedUserIds.push(userId);
      log.error(
        { err, userId, event: "classify_ask_user_failed" },
        "classify-ask: user failed — skipping, other users unaffected",
      );
    }
  }

  log.info(
    {
      event: "classify_ask_done",
      usersProcessed: result.usersProcessed,
      asked: result.asked,
      investigated: result.investigated,
      failedUsers: result.failedUserIds.length,
    },
    "classify-ask complete",
  );
  return result;
}

export function createClassifyAskWorker() {
  return createWorker<ClassifyAskJobData, ClassifyAskResult>(
    "classify-ask",
    async (job) => {
      try {
        return await classifyAskProcessor(job);
      } catch (err) {
        log.error(
          { err, event: "classify_ask_failed", jobId: job.id },
          "classify-ask processor threw — BullMQ will retry",
        );
        throw err;
      }
    },
    { concurrency: 1 },
  );
}
