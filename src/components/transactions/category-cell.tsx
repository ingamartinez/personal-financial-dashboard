"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { updateTransactionCategory } from "@/app/transactions/actions";

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

  return (
    <select
      disabled={pending}
      value={value ?? ""}
      onChange={(e) => {
        const next = e.target.value || null;
        startTransition(async () => {
          try {
            await updateTransactionCategory({ txId, categorySlug: next });
            toast.success("Category updated");
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to update");
          }
        });
      }}
      className="bg-background chevron-select h-8 w-full rounded-md border text-sm disabled:opacity-50"
    >
      <option value="">— unclassified —</option>
      {options.map((c) => (
        <option key={c.slug} value={c.slug}>
          {c.parentSlug ? `↳ ${c.name}` : c.name}
        </option>
      ))}
    </select>
  );
}
