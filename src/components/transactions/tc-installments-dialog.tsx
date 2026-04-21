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
import { formatBpsEmAsEaPercent, parsePercentToBps } from "@/lib/finance/rates";
import { updateTransactionInstallments } from "@/app/(app)/transactions/actions";
import type { Currency } from "@/lib/types";

// #406: edit installments + rate on a TC tx. Only these two fields are
// editable; amount and account stay locked (re-financing = new transfer group,
// not a mutation — see #345 regla 6). An empty rate input means "inherit from
// the account's bucket on compute" (null in DB).
export type TcInstallmentsDialogProps = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  txId: number;
  amountCents: bigint;
  currency: Currency;
  installmentsTotal: number;
  installmentRateBps: number | null;
};

function initialRateInput(bps: number | null): string {
  if (bps == null) return "";
  return (bps / 100).toFixed(4);
}

export function TcInstallmentsDialog({
  open,
  onOpenChange,
  txId,
  amountCents,
  currency,
  installmentsTotal,
  installmentRateBps,
}: TcInstallmentsDialogProps) {
  const [installments, setInstallments] = useState(installmentsTotal.toString());
  const [rate, setRate] = useState(initialRateInput(installmentRateBps));
  const [pending, startTransition] = useTransition();

  const installmentsNum = Number(installments);
  const cuotaCents = useMemo(() => {
    if (!Number.isInteger(installmentsNum) || installmentsNum < 1) return null;
    // Naive equal-cuota preview — the real schedule (with interest) lives in
    // #407. Here we only need to show a "valor_cuota" ballpark per the AC.
    const magnitude = amountCents < BigInt(0) ? -amountCents : amountCents;
    return magnitude / BigInt(installmentsNum);
  }, [amountCents, installmentsNum]);

  const rateBps = rate.trim() === "" ? null : parsePercentToBps(rate);
  const eaPreview = rateBps != null && rateBps > 0 ? formatBpsEmAsEaPercent(rateBps) : null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!Number.isInteger(installmentsNum) || installmentsNum < 1 || installmentsNum > 120) {
      toast.error("Cuotas debe ser un entero entre 1 y 120");
      return;
    }
    startTransition(async () => {
      const result = await updateTransactionInstallments({
        txId,
        installmentsTotal: installmentsNum,
        installmentRateBps: rate.trim() === "" ? null : (parsePercentToBps(rate) ?? 0),
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
            La tasa se usa para calcular intereses causados. Dejá vacío para heredar del bucket de
            la cuenta.
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
              <Label htmlFor="tc-rate">Tasa EM</Label>
              <div className="relative">
                <Input
                  id="tc-rate"
                  type="text"
                  inputMode="decimal"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  placeholder="Heredar bucket"
                  className="pr-10 tabular-nums"
                />
                <span className="text-muted-foreground pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs">
                  %
                </span>
              </div>
              <p className="text-muted-foreground text-xs tabular-nums">
                {eaPreview ? `≈ ${eaPreview} EA` : "—"}
              </p>
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
            <Button type="submit" disabled={pending}>
              {pending ? "Guardando…" : "Guardar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
