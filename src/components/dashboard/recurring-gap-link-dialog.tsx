"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { linkTxToRecurring } from "@/app/settings/recurring/actions";
import type { LinkCandidate } from "@/lib/recurring/gap-queries";

const dateFmt = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "short",
});

export function RecurringGapLinkDialog({
  open,
  onOpenChange,
  recurringId,
  yearMonth,
  label,
  expectedAmountCents,
  currency,
  candidates,
  selectedTxId,
  onSelect,
  onLinked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recurringId: number;
  yearMonth: string;
  label: string;
  expectedAmountCents: bigint;
  currency: "COP" | "USD";
  candidates: LinkCandidate[] | null;
  selectedTxId: number | null;
  onSelect: (txId: number) => void;
  onLinked: () => void;
}) {
  const [pending, startTransition] = useTransition();

  function onLink() {
    if (!selectedTxId) return;
    startTransition(async () => {
      try {
        await linkTxToRecurring({
          txId: selectedTxId,
          recurringId,
          yearMonth,
        });
        toast.success(`Asociado a ${label}`);
        onLinked();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Link failed");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Asociar transacción — {label}</DialogTitle>
          <DialogDescription>
            Mes {yearMonth} · esperado {formatMoney(expectedAmountCents, currency)}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
          {candidates === null ? (
            <>
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </>
          ) : candidates.length > 0 ? (
            candidates.map((c) => {
              const selected = selectedTxId === c.txId;
              return (
                <button
                  key={c.txId}
                  type="button"
                  onClick={() => onSelect(c.txId)}
                  className={cn(
                    "hover:bg-accent flex items-center gap-3 rounded border px-3 py-2 text-left text-sm transition",
                    selected && "border-primary bg-primary/5",
                  )}
                >
                  <div className="text-muted-foreground w-14 text-xs">
                    {dateFmt.format(c.occurredAt)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{c.merchant ?? c.descriptionRaw}</div>
                    {c.merchant ? (
                      <div className="text-muted-foreground truncate text-xs">
                        {c.descriptionRaw}
                      </div>
                    ) : null}
                  </div>
                  <div
                    className={cn(
                      "tabular-nums",
                      c.amountCents < BigInt(0) ? "text-rose-600" : "text-emerald-600",
                    )}
                  >
                    {formatMoney(c.amountCents, currency)}
                  </div>
                </button>
              );
            })
          ) : (
            <p className="text-muted-foreground py-6 text-center text-sm">
              No hay transacciones candidatas sin asociar en la ventana del mes.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancelar
          </Button>
          <Button onClick={onLink} disabled={!selectedTxId || pending}>
            {pending ? "Asociando…" : "Asociar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
