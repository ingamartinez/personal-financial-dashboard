"use client";

import { useTransition } from "react";
import { AlertTriangleIcon, CheckIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Money } from "@/components/display/money";
import { CategoryCell, type CategoryOption } from "@/components/transactions/category-cell";
import { confirmClassification } from "@/app/(app)/transactions/actions";
import type { Currency } from "@/lib/types";

export type ReviewRow = {
  id: number;
  description: string;
  merchant: string | null;
  amountCents: string;
  currency: Currency;
  categorySlug: string;
  categoryName: string;
  confidence: number;
  method: "rule" | "ai";
  accountName: string;
  occurredAt: string;
};

export function ClassificationReviewList({
  rows,
  categories,
}: {
  rows: ReviewRow[];
  categories: CategoryOption[];
}) {
  const [pending, startTransition] = useTransition();

  function onConfirm(row: ReviewRow) {
    startTransition(async () => {
      const result = await confirmClassification({ txId: row.id });
      if (result.status === "error") toast.error(result.message);
      else toast.success(`Confirmada como ${row.categoryName}`);
    });
  }

  return (
    <Card className="border-rose-200 bg-rose-50/40 dark:border-rose-900 dark:bg-rose-950/15">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-rose-900 dark:text-rose-200">
          <AlertTriangleIcon className="size-4" />
          {rows.length} clasificaci{rows.length === 1 ? "ón" : "ones"} a revisar
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {rows.map((r) => {
          const cents = BigInt(r.amountCents);
          const isExpense = cents < BigInt(0);
          return (
            <div
              key={r.id}
              data-testid={`classification-review-row-${r.id}`}
              className="bg-card flex flex-col gap-2 rounded-md border p-3 text-sm sm:flex-row sm:items-center sm:gap-3"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{r.merchant ?? r.description}</div>
                <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                  <span>{r.accountName}</span>
                  <span aria-hidden>·</span>
                  <span>
                    auto {r.method}, confianza {r.confidence}%
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`money shrink-0 text-right font-semibold ${
                    isExpense ? "text-destructive" : "text-emerald-600"
                  }`}
                >
                  <Money cents={cents} currency={r.currency} />
                </span>
              </div>
              <div className="flex min-w-0 flex-col gap-1 sm:w-64">
                <CategoryCell txId={r.id} value={r.categorySlug} options={categories} />
              </div>
              <Button
                variant="default"
                size="sm"
                onClick={() => onConfirm(r)}
                disabled={pending}
                aria-label="Confirmar clasificación"
              >
                <CheckIcon className="size-4" />
                Confirmar
              </Button>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
