"use client";

import { useMemo, useState, useTransition } from "react";
import { WrenchIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Money } from "@/components/display/money";
import { formatAccountLabel } from "@/lib/accounts/format";
import type { AccountRow } from "./accounts-manager";

export function BalanceAdjustDialog({
  open,
  target,
  onClose,
  onConfirm,
}: {
  open: boolean;
  target: AccountRow | null;
  onClose: () => void;
  onConfirm: (declaredBalanceCents: number, reason?: string) => Promise<void>;
}) {
  const [declared, setDeclared] = useState("");
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  const currentCents = target ? BigInt(target.balanceCents) : BigInt(0);
  const currentMajor = Number(currentCents) / 100;

  const declaredCents = useMemo(() => {
    const n = Number(declared);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
  }, [declared]);

  const diffCents = declaredCents !== null ? BigInt(declaredCents) - currentCents : BigInt(0);
  const hasDiff = declaredCents !== null && diffCents !== BigInt(0);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (declaredCents === null || !target) return;
    startTransition(async () => {
      await onConfirm(declaredCents, reason.trim() || undefined);
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <WrenchIcon className="size-4" />
            Ajustar saldo {target ? `· ${formatAccountLabel(target)}` : ""}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label className="text-muted-foreground text-xs tracking-wide uppercase">
              Saldo actual según Findash
            </Label>
            <div className="bg-muted/40 rounded-md border px-3 py-2 text-base font-semibold tabular-nums">
              {target ? <Money cents={currentCents} currency={target.currency} /> : "—"}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="declared">Saldo real (según tu banco)</Label>
            <Input
              id="declared"
              type="number"
              inputMode="decimal"
              step="0.01"
              value={declared}
              onChange={(e) => setDeclared(e.target.value)}
              placeholder={currentMajor.toFixed(2)}
              required
              autoFocus
            />
            <p className="text-muted-foreground text-xs">
              El monto que aparece en el extracto / app del banco ahora mismo.
            </p>
          </div>

          {hasDiff ? (
            <div className="border-border/60 rounded-md border p-3 text-sm">
              Se creará una transacción de{" "}
              <span className="font-semibold tabular-nums">
                {diffCents > BigInt(0) ? "+" : ""}
                {target ? <Money cents={diffCents} currency={target.currency} /> : ""}
              </span>{" "}
              marcada como <strong>Ajuste</strong>. Queda fuera de spend / insights / budgets.
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reason">Razón (opcional)</Label>
            <Textarea
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ej: transferencia que no llegó por SMS, error de parser, etc."
              rows={3}
              maxLength={500}
            />
          </div>

          <DialogFooter>
            <Button variant="ghost" type="button" onClick={onClose} disabled={pending}>
              Cancelar
            </Button>
            <Button type="submit" disabled={pending || !hasDiff}>
              Confirmar ajuste
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
