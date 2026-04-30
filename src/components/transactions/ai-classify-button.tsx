"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Sparkles, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { runAiClassifier, enqueueClassifyAllPending } from "@/app/(app)/transactions/actions";
import { useNotificationStream } from "@/lib/notifications/use-notification-stream";

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
 * After enqueuing, subscribes via SSE to job:progress / job:done events
 * filtered by the returned jobId. The button label updates with live pending
 * counts while the drain runs, and reverts after job:done fires a success toast.
 *
 * Note on idempotency: BullMQ deduplicates via the `deduplication` option
 * (`drain-<userId>`). Unlike the old `jobId`-based approach, the dedup key is
 * automatically cleaned up when the job completes — so subsequent clicks after
 * a completed drain correctly enqueue a new job. The server action returns
 * `alreadyRunning: true` when an active job was deduplicated; the toast surfaces
 * this truthfully instead of lying "Encolados N" when nothing was actually added.
 */
export function DrainAllPendingButton({ unclassified }: { unclassified: number }) {
  const router = useRouter();
  const [transitioning, startTransition] = useTransition();

  // Track the running job so SSE handler can filter events.
  // Using both state (for re-render) and ref (for stable closure in SSE handler).
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const currentJobIdRef = useRef<string | null>(null);

  // Live progress state — shown in button label while drain is active.
  const [drainPending, setDrainPending] = useState<number | null>(null);

  const isRunning = currentJobId !== null;
  const disabled = transitioning || isRunning || unclassified === 0;

  useNotificationStream((event) => {
    const jobId = currentJobIdRef.current;
    if (!jobId) return;

    if (event.type === "job:progress" && event.jobName === "classify-tx" && event.jobId === jobId) {
      setDrainPending(event.pending);
      return;
    }

    if (event.type === "job:done" && event.jobName === "classify-tx" && event.jobId === jobId) {
      toast.success(`✓ ${event.classifiedCount} clasificadas`);
      currentJobIdRef.current = null;
      setCurrentJobId(null);
      setDrainPending(null);
      router.refresh();
    }
  });

  function onClick() {
    startTransition(async () => {
      try {
        const res = await enqueueClassifyAllPending();
        if (res.alreadyRunning) {
          toast.info("Ya hay un drain en curso — mirá /admin/queues");
          return;
        }
        if (res.enqueued === 0) {
          toast.info("No pending transactions to classify");
          return;
        }
        if (res.jobId) {
          currentJobIdRef.current = res.jobId;
          setCurrentJobId(res.jobId);
          setDrainPending(res.enqueued);
        }
        toast.success(`Encolados ${res.enqueued.toLocaleString()} — te aviso cuando termine`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to enqueue drain job");
      }
    });
  }

  function getLabel(): string {
    if (transitioning) return "Enqueuing…";
    if (isRunning && drainPending !== null) return `Drenando ${drainPending.toLocaleString()}…`;
    if (isRunning) return "Drenando…";
    if (unclassified === 0) return "All classified";
    return `Classify All Pending (${unclassified.toLocaleString()})`;
  }

  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={disabled}>
      <Zap className="size-4" />
      {getLabel()}
    </Button>
  );
}
