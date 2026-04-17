"use client";

import { useTransition } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { classifySingleWithAi, updateTransactionCategory } from "@/app/transactions/actions";
import { Button } from "@/components/ui/button";
import { CategoryCombobox } from "./category-combobox";

export type CategoryOption = {
  slug: string;
  name: string;
  parentSlug: string | null;
};

export function CategoryCell({
  txId,
  value,
  options,
}: {
  txId: number;
  value: string | null;
  options: CategoryOption[];
}) {
  const [pending, startTransition] = useTransition();
  const [aiPending, startAiTransition] = useTransition();
  const busy = pending || aiPending;
  const isUnclassified = value === null;

  return (
    <div className="flex items-center gap-1.5">
      <CategoryCombobox
        value={value}
        options={options}
        disabled={busy}
        onChange={(next) => {
          startTransition(async () => {
            try {
              await updateTransactionCategory({ txId, categorySlug: next });
              toast.success("Category updated");
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Failed to update");
            }
          });
        }}
        triggerClassName="h-8"
      />
      {isUnclassified ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          disabled={busy}
          aria-label="Classify with AI"
          title="Classify with AI"
          onClick={() => {
            startAiTransition(async () => {
              try {
                const res = await classifySingleWithAi({ txId });
                const pct = Math.round(res.confidence);
                if (pct < 50) {
                  toast.warning(`Classified as ${res.categoryName} · low confidence (${pct}%)`);
                } else {
                  toast.success(`Classified as ${res.categoryName} (${pct}%)`);
                }
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "AI classify failed");
              }
            });
          }}
        >
          <Sparkles className={aiPending ? "size-4 animate-pulse" : "size-4"} />
        </Button>
      ) : null}
    </div>
  );
}
