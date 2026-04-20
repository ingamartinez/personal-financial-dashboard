"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Money } from "@/components/display/money";
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

export type MergeCandidate = {
  id: number;
  occurredAt: string;
  amountCents: string;
  currency: "COP" | "USD";
  descriptionRaw: string;
};

const dateFmt = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "short",
  year: "2-digit",
});

export function FlaggedReview({
  rows,
  currency,
  mergeCandidates,
}: {
  rows: FlaggedRow[];
  currency: Currency;
  mergeCandidates: MergeCandidate[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<number | null>(null);
  const [mergePicker, setMergePicker] = useState<FlaggedRow | null>(null);

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

  function handleMerge(flaggedId: number, targetId: number) {
    setBusy(flaggedId);
    startTransition(async () => {
      try {
        await reviewReconciliationDecision({
          txnId: flaggedId,
          action: "merged_into",
          mergedIntoTxnId: targetId,
        });
        toast.success("Merged — flagged row inherits the statement amount & date");
        setMergePicker(null);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Merge failed");
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
                      <Money cents={cents} currency={currency} />
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
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setMergePicker(r)}
                          disabled={pending || isBusy || mergeCandidates.length === 0}
                          title={
                            mergeCandidates.length === 0
                              ? "No statement-imported rows available to merge with"
                              : "Merge into a statement-imported row"
                          }
                        >
                          Merge into…
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
      <MergePickerDialog
        open={mergePicker !== null}
        flagged={mergePicker}
        candidates={mergeCandidates}
        currency={currency}
        disabled={pending}
        onClose={() => setMergePicker(null)}
        onPick={handleMerge}
      />
    </Card>
  );
}

function MergePickerDialog({
  open,
  flagged,
  candidates,
  currency,
  disabled,
  onClose,
  onPick,
}: {
  open: boolean;
  flagged: FlaggedRow | null;
  candidates: MergeCandidate[];
  currency: Currency;
  disabled: boolean;
  onClose: () => void;
  onPick: (flaggedId: number, targetId: number) => void;
}) {
  const sorted = useMemo(() => {
    if (!flagged) return candidates;
    const flaggedMs = new Date(flagged.occurredAt).getTime();
    return [...candidates].sort((a, b) => {
      const da = Math.abs(new Date(a.occurredAt).getTime() - flaggedMs);
      const db = Math.abs(new Date(b.occurredAt).getTime() - flaggedMs);
      return da - db;
    });
  }, [flagged, candidates]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Merge flagged into…</DialogTitle>
          <DialogDescription>
            {flagged
              ? `Pick the statement-imported row that corresponds to "${flagged.descriptionRaw}" (${formatMoney(BigInt(flagged.amountCents), currency)}, ${dateFmt.format(new Date(flagged.occurredAt))}). The flagged row keeps its category and adopts the statement's amount + date.`
              : null}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground text-xs uppercase">
              <tr>
                <th className="p-2 text-left">Date</th>
                <th className="p-2 text-left">Description</th>
                <th className="p-2 text-right">Amount</th>
                <th className="p-2 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => {
                const cents = BigInt(c.amountCents);
                return (
                  <tr key={c.id} className="border-t">
                    <td className="p-2 tabular-nums">{dateFmt.format(new Date(c.occurredAt))}</td>
                    <td className="max-w-[22rem] truncate p-2">{c.descriptionRaw}</td>
                    <td
                      className={cn(
                        "p-2 text-right font-medium tabular-nums",
                        cents < BigInt(0) ? "text-rose-600" : "text-emerald-600",
                      )}
                    >
                      <Money cents={cents} currency={currency} />
                    </td>
                    <td className="p-2 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={disabled}
                        onClick={() => flagged && onPick(flagged.id, c.id)}
                      >
                        Merge
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
