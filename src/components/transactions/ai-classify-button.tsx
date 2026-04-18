"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { runAiClassifier } from "@/app/(app)/transactions/actions";

export function AiClassifyButton({ unclassified }: { unclassified: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const batchSize = Math.min(unclassified, 20);
  const disabled = pending || unclassified === 0;

  function onClick() {
    startTransition(async () => {
      try {
        const res = await runAiClassifier();
        if (res.picked === 0) {
          toast.info("Nothing to classify");
          return;
        }
        toast.success(
          `Classified ${res.aiClassified} via AI · ${res.ruleClassified} via rules · ${res.skipped} skipped`,
        );
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
