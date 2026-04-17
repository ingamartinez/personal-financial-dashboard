"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { updateTransactionCategory } from "@/app/transactions/actions";
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

  return (
    <CategoryCombobox
      value={value}
      options={options}
      disabled={pending}
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
  );
}
