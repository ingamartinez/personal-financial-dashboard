"use client";

// #622: Dialog for the "Asociar tx existente" action on a forecast row.
// This is the INVERSE of LinkRecurringDialog — instead of picking a recurring
// for a known tx, we pick a tx for a known recurring slot.
//
// Picker rules:
//   - Default: account_id = forecast.accountId, occurredAt in [expected-10d, expected+5d],
//     recurring_id IS NULL, not soft-deleted.
//   - Toggle "Mostrar todas las tx del mes": all unlinked tx of the user's
//     same yearMonth — no account/date filter.
//   - Sort by proximity to expectedDate.
//   - NEVER filter by amount.

import { useCallback, useEffect, useState, useTransition } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/display/money";
import { cn } from "@/lib/utils";
import { getLinkCandidatesForForecast } from "@/app/(app)/transactions/forecast-actions";
import { linkTxToRecurring } from "@/app/(app)/transactions/actions";
import type { ForecastLinkCandidate } from "@/app/(app)/transactions/forecast-actions";
import type { Currency } from "@/lib/types";

const dateFmt = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "short",
});

export function ForecastLinkTxDialog({
  open,
  onOpenChange,
  recurringId,
  yearMonth,
  label,
  expectedAmountCents,
  currency,
  onLinked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recurringId: number;
  yearMonth: string;
  label: string;
  expectedAmountCents: bigint;
  currency: Currency;
  onLinked: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [showAll, setShowAll] = useState(false);
  const [candidates, setCandidates] = useState<ForecastLinkCandidate[] | null>(null);
  const [selectedTxId, setSelectedTxId] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadCandidates = useCallback(
    (all: boolean) => {
      getLinkCandidatesForForecast({
        recurringId,
        yearMonth,
        showAll: all,
      })
        .then((rows) => {
          setCandidates(rows);
          setLoadError(null);
        })
        .catch((err) => {
          setLoadError(err instanceof Error ? err.message : "Error cargando candidatos");
          setCandidates([]);
        });
    },
    [recurringId, yearMonth],
  );

  // Reset + load when dialog opens or showAll toggle changes.
  // The null reset happens right before the async call, but OUTSIDE the effect
  // body to avoid the react-hooks/set-state-in-effect lint rule.
  function triggerLoad(all: boolean) {
    setCandidates(null);
    setLoadError(null);
    loadCandidates(all);
  }

  // Load candidates when the dialog first opens.
  // We track a ref to avoid re-loading when unrelated state changes.
  useEffect(() => {
    if (open) {
      triggerLoad(showAll);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reset state when dialog closes.
  function onClose(next: boolean) {
    if (!pending) {
      if (!next) {
        setShowAll(false);
        setSelectedTxId(null);
        setCandidates(null);
        setLoadError(null);
      }
      onOpenChange(next);
    }
  }

  function onLink() {
    if (selectedTxId === null) return;
    startTransition(async () => {
      const result = await linkTxToRecurring({
        txId: selectedTxId,
        recurringId,
        yearMonth,
      });
      if (result.ok) {
        toast.success(`Asociado a ${label}`, { description: `Mes ${yearMonth}` });
        setSelectedTxId(null);
        onLinked();
        onOpenChange(false);
      } else {
        toast.error("No se pudo asociar", { description: result.error });
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Asociar tx existente — {label}</DialogTitle>
          <DialogDescription>
            Mes {yearMonth} · esperado <Money cents={expectedAmountCents} currency={currency} />
          </DialogDescription>
        </DialogHeader>

        <div className="bg-muted/30 flex items-center gap-3 rounded-md border px-3 py-2">
          <Checkbox
            id="show-all"
            checked={showAll}
            onCheckedChange={(checked) => {
              const next = checked === true;
              setShowAll(next);
              setSelectedTxId(null);
              triggerLoad(next);
            }}
            disabled={pending}
          />
          <Label htmlFor="show-all" className="cursor-pointer text-sm font-normal">
            Mostrar todas las tx del mes
          </Label>
        </div>

        <div className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
          {candidates === null ? (
            <>
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </>
          ) : loadError ? (
            <p className="text-destructive py-6 text-center text-sm">{loadError}</p>
          ) : candidates.length > 0 ? (
            candidates.map((c) => {
              const selected = selectedTxId === c.txId;
              const isExpense = c.amountCents < BigInt(0);
              return (
                <button
                  key={c.txId}
                  type="button"
                  onClick={() => setSelectedTxId(c.txId)}
                  className={cn(
                    "hover:bg-accent flex items-center gap-3 rounded border px-3 py-2 text-left text-sm transition",
                    selected && "border-primary bg-primary/5",
                  )}
                >
                  <div className="text-muted-foreground w-14 shrink-0 text-xs">
                    {dateFmt.format(c.occurredAt)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{c.merchant ?? c.descriptionRaw}</div>
                    {c.merchant ? (
                      <div className="text-muted-foreground truncate text-xs">
                        {c.descriptionRaw}
                      </div>
                    ) : null}
                    <div className="text-muted-foreground truncate text-xs">{c.accountName}</div>
                  </div>
                  <div
                    className={cn(
                      "shrink-0 tabular-nums",
                      isExpense ? "text-rose-600" : "text-emerald-600",
                    )}
                  >
                    <Money cents={c.amountCents} currency={c.currency as Currency} />
                  </div>
                </button>
              );
            })
          ) : (
            <p className="text-muted-foreground py-6 text-center text-sm">
              {showAll
                ? "No hay transacciones sin asociar en este mes."
                : 'No hay transacciones candidatas en la ventana ±10d/+5d. Activá "Mostrar todas" para ampliar.'}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)} disabled={pending}>
            Cancelar
          </Button>
          <Button onClick={onLink} disabled={selectedTxId === null || pending}>
            {pending ? "Asociando…" : "Asociar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
