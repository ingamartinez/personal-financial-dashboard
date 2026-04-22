"use client";

import { useMemo, useState, useTransition } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/display/money";
import { EM_X10K_SCALE, formatEmX10kAsEaPercent, parsePercentToEmX10k } from "@/lib/finance/rates";
import { updateTransactionInstallments } from "@/app/(app)/transactions/actions";
import type { Currency } from "@/lib/types";

// #406/#416: edit installments + rate on a TC tx. Only these two fields are
// editable; amount and account stay locked (re-financing = new transfer group,
// not a mutation — see #345 regla 6).
//
// Rate semantics (post #416):
//   - cuotas = 1: rate is ignored (diferido sin intereses). Empty is fine.
//   - cuotas > 1: rate is REQUIRED. No silent fallback to the account bucket
//     because bucket rates change monthly at Bancolombia (regla 3) and the
//     user is the source of truth for "what the bank snapshoted for this
//     tx". Empty submit is rejected client-side + server-side.
export type TcInstallmentsDialogProps = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  txId: number;
  amountCents: bigint;
  currency: Currency;
  installmentsTotal: number;
  installmentRateEmX10k: number | null;
};

function initialRateInput(emX10k: number | null): string {
  if (emX10k == null) return "";
  // stored EM is percent × 10000; show 4 decimals so "19110" → "1.9110"
  return (emX10k / EM_X10K_SCALE).toFixed(4);
}

export function TcInstallmentsDialog({
  open,
  onOpenChange,
  txId,
  amountCents,
  currency,
  installmentsTotal,
  installmentRateEmX10k,
}: TcInstallmentsDialogProps) {
  const [installments, setInstallments] = useState(installmentsTotal.toString());
  const [rate, setRate] = useState(initialRateInput(installmentRateEmX10k));
  const [pending, startTransition] = useTransition();

  const installmentsNum = Number(installments);
  const cuotaCents = useMemo(() => {
    if (!Number.isInteger(installmentsNum) || installmentsNum < 1) return null;
    // Naive equal-cuota preview — the real schedule (with interest) lives in
    // #407. Here we only need to show a "valor_cuota" ballpark per the AC.
    const magnitude = amountCents < BigInt(0) ? -amountCents : amountCents;
    return magnitude / BigInt(installmentsNum);
  }, [amountCents, installmentsNum]);

  const rateEmX10k = rate.trim() === "" ? null : parsePercentToEmX10k(rate);
  const eaPreview =
    rateEmX10k != null && rateEmX10k > 0 ? formatEmX10kAsEaPercent(rateEmX10k) : null;
  // #416: when cuotas > 1, rate is mandatory. Disable submit + show inline
  // message; we also double-check server-side in the zod schema.
  const rateRequired = Number.isInteger(installmentsNum) && installmentsNum > 1;
  const rateMissing = rateRequired && rate.trim() === "";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!Number.isInteger(installmentsNum) || installmentsNum < 1 || installmentsNum > 120) {
      toast.error("Cuotas debe ser un entero entre 1 y 120");
      return;
    }
    if (rateMissing) {
      toast.error("Ingresá la tasa EM del extracto para compras a cuotas.");
      return;
    }
    startTransition(async () => {
      const result = await updateTransactionInstallments({
        txId,
        installmentsTotal: installmentsNum,
        installmentRateEmX10k: rate.trim() === "" ? null : (parsePercentToEmX10k(rate) ?? 0),
      });
      if (result.status === "error") {
        toast.error(result.message);
        return;
      }
      toast.success("Cuotas actualizadas");
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Editar cuotas</DialogTitle>
          <DialogDescription>
            La tasa se usa para calcular intereses causados. Para compras a cuotas (&gt; 1) es
            obligatoria — la sacás del extracto mensual. Para 1 cuota, dejala vacía.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tc-installments">Cuotas</Label>
              <Input
                id="tc-installments"
                type="number"
                min="1"
                max="120"
                value={installments}
                onChange={(e) => setInstallments(e.target.value)}
                required
                className="tabular-nums"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tc-rate">
                Tasa EM {rateRequired ? <span className="text-destructive">*</span> : null}
              </Label>
              <div className="relative">
                <Input
                  id="tc-rate"
                  type="text"
                  inputMode="decimal"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  placeholder={rateRequired ? "Ej: 1.9110" : "Sin interés"}
                  aria-invalid={rateMissing || undefined}
                  className="pr-10 tabular-nums"
                />
                <span className="text-muted-foreground pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs">
                  %
                </span>
              </div>
              {rateMissing ? (
                <p className="text-destructive text-xs">
                  Obligatoria para compras a cuotas. Mirá el extracto del mes.
                </p>
              ) : (
                <p className="text-muted-foreground text-xs tabular-nums">
                  {eaPreview ? `≈ ${eaPreview} EA` : "—"}
                </p>
              )}
            </div>
          </div>

          {cuotaCents != null && installmentsNum > 1 ? (
            <div className="bg-muted/40 text-muted-foreground rounded-md border px-3 py-2 text-xs">
              Valor cuota estimado (solo capital, sin interés):{" "}
              <strong className="text-foreground">
                <Money cents={cuotaCents} currency={currency} />
              </strong>
              . El cálculo con intereses correcto vive en #407 (helper por llegar).
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={pending || rateMissing}>
              {pending ? "Guardando…" : "Guardar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
