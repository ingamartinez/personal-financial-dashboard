"use client";

// #762: Dialog for manually linking an existing transaction to another existing
// transaction as a transfer pair. Follows the same pattern as LinkRecurringDialog
// and LinkCounterpartyDialog.

import { useEffect, useState, useTransition } from "react";
import { ArrowLeftRightIcon } from "lucide-react";
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
import { Money } from "@/components/display/money";
import { formatAccountLabel } from "@/lib/accounts/format";
import { findTransferCandidates, linkExistingAsTransfer } from "@/app/(app)/transactions/actions";
import type { TransferCandidate } from "@/app/(app)/transactions/link-transfer-types";
import type { Currency } from "@/lib/types";

type SourceTx = {
  id: number;
  amountCents: bigint;
  currency: Currency;
  descriptionRaw?: string;
};

export function LinkTransferDialog({
  open,
  onOpenChange,
  sourceTransaction,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceTransaction: SourceTx;
}) {
  const [pending, startTransition] = useTransition();
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [candidates, setCandidates] = useState<TransferCandidate[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Load candidates whenever the dialog opens. Resets happen asynchronously
  // to avoid the react-hooks/set-state-in-effect rule (no synchronous setState
  // at the effect body top level).
  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    // Defer the reset + fetch so the first setState inside the effect is async.
    Promise.resolve().then(() => {
      if (cancelled) return;
      setSelectedId(null);
      setCandidates([]);
      setLoadingCandidates(true);

      return findTransferCandidates({ txId: sourceTransaction.id })
        .then((rows) => {
          if (!cancelled) setCandidates(rows);
        })
        .catch(() => {
          if (!cancelled) setCandidates([]);
        })
        .finally(() => {
          if (!cancelled) setLoadingCandidates(false);
        });
    });

    return () => {
      cancelled = true;
    };
  }, [open, sourceTransaction.id]);

  function handleConfirm() {
    if (selectedId === null) return;
    startTransition(async () => {
      const result = await linkExistingAsTransfer({
        txIdA: sourceTransaction.id,
        txIdB: selectedId,
      });
      if (result.status === "ok") {
        toast.success("Transacciones linkeadas como transferencia", {
          description: "La categoría fue removida de ambas.",
        });
        setSelectedId(null);
        onOpenChange(false);
      } else {
        toast.error("No se pudo linkear", { description: result.message });
      }
    });
  }

  function handleClose() {
    if (!pending) {
      setSelectedId(null);
      onOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRightIcon className="size-4" />
            Linkear como transferencia
          </DialogTitle>
          <DialogDescription>
            Seleccioná la transacción que representa la otra punta de esta transferencia. Ambas
            transacciones perderán su categoría y quedarán marcadas como transferencia.
          </DialogDescription>
        </DialogHeader>

        {/* Warning */}
        <div className="bg-muted rounded-md px-3 py-2 text-sm">
          <span className="font-medium">Aviso:</span> Esta acción quita la categoría de ambas
          transacciones y las marca como transferencia interna.
        </div>

        {/* Candidates list */}
        <div className="flex max-h-64 flex-col gap-1 overflow-y-auto py-1">
          {loadingCandidates ? (
            <p className="text-muted-foreground px-1 py-4 text-center text-sm">
              Buscando candidatas…
            </p>
          ) : candidates.length === 0 ? (
            <p className="text-muted-foreground px-1 py-4 text-center text-sm">
              No hay candidatas dentro de ±30 días con el mismo monto absoluto en otra cuenta.
            </p>
          ) : (
            candidates.map((c) => {
              const accountLabel = formatAccountLabel({
                name: c.accountName,
                currency: c.accountCurrency,
                institution: c.accountInstitution,
              });
              const dateStr = new Date(c.occurredAt).toLocaleDateString("es-CO", {
                day: "2-digit",
                month: "short",
                year: "numeric",
              });
              const isSelected = selectedId === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedId(isSelected ? null : c.id)}
                  disabled={pending}
                  data-testid={`transfer-candidate-${c.id}`}
                  className={[
                    "flex min-w-0 items-start gap-3 rounded-md border px-3 py-2 text-left transition-colors",
                    isSelected
                      ? "border-primary bg-primary/5"
                      : "hover:bg-muted hover:border-border border-transparent",
                  ].join(" ")}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {c.descriptionClean ?? c.merchant ?? c.descriptionRaw}
                    </div>
                    <div className="text-muted-foreground truncate text-xs">
                      {accountLabel} · {dateStr}
                    </div>
                  </div>
                  <div className="shrink-0 text-sm tabular-nums">
                    <Money cents={c.amountCents} currency={c.currency as Currency} />
                  </div>
                </button>
              );
            })
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={pending}>
            Cancelar
          </Button>
          <Button onClick={handleConfirm} disabled={selectedId === null || pending}>
            {pending ? "Linkeando…" : "Linkear como transferencia"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
