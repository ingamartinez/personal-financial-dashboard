"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { Currency } from "@/lib/types";
import { reviewReconciliationDecision } from "./actions";

export type FlaggedRow = {
  id: number;
  occurredAt: string;
  amountCents: string;
  currency: "COP" | "USD";
  descriptionRaw: string;
  merchant: string | null;
};

const dateFmt = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "short",
  year: "2-digit",
});

export function FlaggedReview({ rows, currency }: { rows: FlaggedRow[]; currency: Currency }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<number | null>(null);

  function handle(rowId: number, action: "archived" | "kept") {
    setBusy(rowId);
    startTransition(async () => {
      try {
        await reviewReconciliationDecision({ txnId: rowId, action });
        toast.success(
          action === "archived"
            ? "Transaction archived (won't show in spend anymore)"
            : "Transaction kept as real (status reset to unreconciled)",
        );
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Action failed");
      } finally {
        setBusy(null);
      }
    });
  }

  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Flagged · {rows.length}</CardTitle>
        <CardDescription>
          These transactions exist in findash but were NOT found in a reconciled statement. They are
          probably reversals, cancellations, or duplicates. Decide one-by-one:
          <span className="ml-1">
            <em>Archive</em> to exclude from spend, <em>Keep</em> if it&apos;s real and should stay.
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground text-xs uppercase">
              <tr>
                <th className="p-2 text-left">Date</th>
                <th className="p-2 text-left">Description</th>
                <th className="p-2 text-right">Amount</th>
                <th className="p-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const cents = BigInt(r.amountCents);
                const isBusy = busy === r.id;
                return (
                  <tr key={r.id} className="border-t">
                    <td className="p-2 tabular-nums">{dateFmt.format(new Date(r.occurredAt))}</td>
                    <td className="max-w-[18rem] truncate p-2">
                      {r.descriptionRaw}
                      {r.merchant ? (
                        <span className="text-muted-foreground text-xs"> · {r.merchant}</span>
                      ) : null}
                    </td>
                    <td
                      className={cn(
                        "p-2 text-right font-medium tabular-nums",
                        cents < BigInt(0) ? "text-rose-600" : "text-emerald-600",
                      )}
                    >
                      {formatMoney(cents, currency)}
                    </td>
                    <td className="p-2 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handle(r.id, "archived")}
                          disabled={pending || isBusy}
                        >
                          Archive
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handle(r.id, "kept")}
                          disabled={pending || isBusy}
                        >
                          Keep
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
