"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Sparkles, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { runAiClassifier, enqueueClassifyAllPending } from "@/app/(app)/transactions/actions";

export function AiClassifyButton({ unclassified }: { unclassified: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const batchSize = Math.min(unclassified, 20);
  const disabled = pending || unclassified === 0;

  function onClick() {
    startTransition(async () => {
      try {
        const res = await runAiClassifier();
        if (res.enqueued === 0) {
          toast.info("Nothing to classify");
          return;
        }
        toast.success(`Queued ${res.enqueued} transactions for AI classification`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "AI classify failed");
      }
    });
  }

  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={disabled}>
      <Sparkles className="size-4" />
      {pending
        ? "Classifying…"
        : unclassified === 0
          ? "All classified"
          : `Classify ${batchSize} with AI${unclassified > 20 ? ` (${unclassified} pending)` : ""}`}
    </Button>
  );
}

/**
 * Enqueues a single drain-pending job that drains ALL pending transactions for
 * the session user. The worker runs until empty (capped at 2000 txs).
 *
 * Note on idempotency: BullMQ deduplicates by jobId (`drain-<userId>`), so
 * multiple clicks while a drain is already running are no-ops at the queue
 * level. The button has no local "is draining" state — relying on this server-
 * side dedup avoids polling the job status from the client.
 */
export function DrainAllPendingButton({ unclassified }: { unclassified: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const disabled = pending || unclassified === 0;

  function onClick() {
    startTransition(async () => {
      try {
        const res = await enqueueClassifyAllPending();
        if (res.enqueued === 0) {
          toast.info("No pending transactions to classify");
          return;
        }
        toast.success(`Encolados ${res.enqueued.toLocaleString()} — te aviso cuando termine`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to enqueue drain job");
      }
    });
  }

  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={disabled}>
      <Zap className="size-4" />
      {pending
        ? "Enqueuing…"
        : unclassified === 0
          ? "All classified"
          : `Classify All Pending (${unclassified.toLocaleString()})`}
    </Button>
  );
}
