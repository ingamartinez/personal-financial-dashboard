import { subscribe } from "@/lib/events/bus";
import { emitNotification } from "@/lib/notifications/emit";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "notifications/gmail-pull-completion" });

/**
 * Registers a bus subscriber that emits a `gmail_pull_completed` notification
 * when a user-triggered Gmail sync job finishes.
 *
 * Only `job:done` events with `jobName === "gmail-pull"` are handled — the
 * cron `mode: "all"` path never reaches this subscriber because the worker
 * only emits `job:done` for `mode: "single-user"` jobs.
 *
 * Returns the unsubscribe function.
 */
export function registerGmailPullCompletionEmitter(): () => void {
  const unsubscribe = subscribe(async (event) => {
    if (event.type !== "job:done" || event.jobName !== "gmail-pull") return;

    const { userId, jobId, newTxCount, processedCount } = event;

    const body =
      newTxCount > 0
        ? `Encontramos ${newTxCount} movimiento(s) nuevos.`
        : "No encontramos movimientos nuevos.";

    try {
      const result = await emitNotification(userId, {
        type: "gmail_pull_completed",
        entityId: jobId,
        priority: "low",
        title: "Sincronización Gmail completada",
        body,
        actionUrl: "/transactions",
        metadata: { newTxCount, processedCount, jobId },
      });

      if (result !== null) {
        log.info(
          {
            userId,
            jobId,
            newTxCount,
            processedCount,
            notificationId: result.id,
            event: "gmail_pull_completion_emitted",
          },
          "gmail_pull_completed notification emitted",
        );
      } else {
        log.debug(
          { userId, jobId, event: "gmail_pull_completion_dedup" },
          "gmail_pull_completed notification deduped",
        );
      }
    } catch (err) {
      log.error(
        { err, userId, jobId, event: "gmail_pull_completion_failed" },
        "failed to emit gmail_pull_completed notification",
      );
    }
  });

  log.info(
    { event: "gmail_pull_completion_registered" },
    "gmail-pull-completion emitter registered",
  );
  return unsubscribe;
}
