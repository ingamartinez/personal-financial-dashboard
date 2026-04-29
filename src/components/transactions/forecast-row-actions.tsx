"use client";

// #622: Action menu for forecast (virtual) rows in the /transactions list.
// A forecast row is NOT a real transaction — it represents a recurring that
// hasn't been covered yet for this month. Three actions:
//   1. "Asociar tx existente" → ForecastLinkTxDialog (pick existing tx)
//   2. "Pagué $___" → createSyntheticForGap (create synthetic tx)
//   3. "No pagué" → skipGap (dismiss/skip this month)

import { useState, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LinkIcon, MoreHorizontalIcon, WalletIcon, CircleXIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ForecastLinkTxDialog } from "./forecast-link-tx-dialog";
import { createSyntheticForGap, skipGap } from "@/app/(app)/transactions/forecast-actions";
import type { Currency } from "@/lib/types";

type Props = {
  recurringId: number;
  yearMonth: string;
  label: string;
  expectedAmountCents: bigint;
  currency: Currency;
  expectedDateIso: string; // ISO string for the expected date (for synthetic default date)
};

export function ForecastRowActions({
  recurringId,
  yearMonth,
  label,
  expectedAmountCents,
  currency,
  expectedDateIso,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [linkOpen, setLinkOpen] = useState(false);
  const [paidOpen, setPaidOpen] = useState(false);
  const [skipOpen, setSkipOpen] = useState(false);

  // "Pagué" form state.
  const expectedDate = new Date(expectedDateIso);
  const defaultDateStr = expectedDate.toISOString().slice(0, 10);
  const defaultAmountStr = (
    Number(expectedAmountCents < BigInt(0) ? -expectedAmountCents : expectedAmountCents) / 100
  ).toFixed(currency === "USD" ? 2 : 0);

  const [paidAmount, setPaidAmount] = useState(defaultAmountStr);
  const [paidDate, setPaidDate] = useState(defaultDateStr);

  function onPaidSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amtNum = Number(paidAmount);
    if (!Number.isFinite(amtNum) || amtNum <= 0) {
      toast.error("Monto debe ser > 0");
      return;
    }
    const centsMagnitude = Math.round(amtNum * 100);
    startTransition(async () => {
      try {
        await createSyntheticForGap({
          recurringId,
          yearMonth,
          occurredOn: paidDate,
          amountCents: String(centsMagnitude),
        });
        toast.success(`Registrado ${label}`);
        setPaidOpen(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Error al registrar");
      }
    });
  }

  function onSkip() {
    startTransition(async () => {
      try {
        await skipGap({ recurringId, yearMonth });
        toast.success(`Marcado como no pagado: ${label}`);
        setSkipOpen(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Error");
      }
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground size-7"
            aria-label="Forecast row actions"
            disabled={pending}
          >
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
            {label}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setLinkOpen(true);
            }}
            disabled={pending}
          >
            <LinkIcon className="size-4" />
            Asociar tx existente
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setPaidOpen(true);
            }}
            disabled={pending}
          >
            <WalletIcon className="size-4" />
            Pagué…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setSkipOpen(true);
            }}
            disabled={pending}
            variant="destructive"
          >
            <CircleXIcon className="size-4" />
            No pagué
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Asociar tx existente */}
      <ForecastLinkTxDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        recurringId={recurringId}
        yearMonth={yearMonth}
        label={label}
        expectedAmountCents={expectedAmountCents}
        currency={currency}
        onLinked={() => {
          /* revalidatePath in the action handles cache bust */
        }}
      />

      {/* Pagué $__ */}
      <Dialog
        open={paidOpen}
        onOpenChange={(next) => {
          if (!pending) setPaidOpen(next);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Registrar pago — {label}</DialogTitle>
            <DialogDescription>Mes {yearMonth}</DialogDescription>
          </DialogHeader>
          <form onSubmit={onPaidSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="forecast-paid-amount" className="text-sm">
                Monto pagado ({currency})
              </Label>
              <Input
                id="forecast-paid-amount"
                type="number"
                inputMode="decimal"
                step={currency === "USD" ? "0.01" : "1"}
                min="0"
                value={paidAmount}
                onChange={(e) => setPaidAmount(e.target.value)}
                required
                autoFocus
                className="tabular-nums"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="forecast-paid-date" className="text-sm">
                Fecha
              </Label>
              <Input
                id="forecast-paid-date"
                type="date"
                value={paidDate}
                onChange={(e) => setPaidDate(e.target.value)}
                required
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setPaidOpen(false)}
                disabled={pending}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Guardando…" : "Confirmar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* No pagué — skip confirm */}
      <AlertDialog open={skipOpen} onOpenChange={setSkipOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Marcar como no pagado?</AlertDialogTitle>
            <AlertDialogDescription>
              Se marca que <strong>{label}</strong> de {yearMonth} no fue pagado este mes. Podés
              revertirlo desde Recurrentes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={onSkip} disabled={pending}>
              {pending ? "Marcando…" : "No pagué"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
