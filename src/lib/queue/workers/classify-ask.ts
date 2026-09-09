// #814 Phase 4: classify-ask BullMQ worker.
// Sends at most one Telegram classification question per user for opaque
// gateway rows with zero correlation candidates. Never runs inside the sweep
// loop — sweep/pipeline only enqueue this job.

import type { Job } from "bullmq";

import { createLogger } from "@/lib/logger";
import { createWorker } from "@/lib/queue";
import type { ClassifyAskJobData } from "@/lib/classification/enqueue";
import { listActiveAskUserIds, processAskForUser } from "@/lib/classification/ask-user";

const log = createLogger({ module: "worker/classify-ask" });

export type { ClassifyAskJobData };

export type ClassifyAskResult = {
  usersProcessed: number;
  asked: number;
  failedUserIds: number[];
};

export async function classifyAskProcessor(
  job: Job<ClassifyAskJobData>,
): Promise<ClassifyAskResult> {
  const { mode } = job.data;
  log.info({ event: "classify_ask_start", mode, jobId: job.id }, "classify-ask started");

  const userIds = mode === "single-user" ? [job.data.userId] : await listActiveAskUserIds();

  const result: ClassifyAskResult = { usersProcessed: 0, asked: 0, failedUserIds: [] };

  for (const userId of userIds) {
    try {
      const userResult = await processAskForUser(userId);
      result.usersProcessed++;
      if (userResult.askedTxId != null) result.asked++;
      await job.log(
        `userId=${userId} askedTxId=${userResult.askedTxId ?? "-"} skipped=${userResult.skipped ?? "-"} expired=${userResult.expiredCount} requeued=${userResult.requeuedCount}`,
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
