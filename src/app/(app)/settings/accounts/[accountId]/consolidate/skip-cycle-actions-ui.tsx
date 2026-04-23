"use client";

// #436 — client surface for skip / unskip cycle actions. Lives next to the
// server actions in `skip-actions.ts`; consumed by TcConsolidationStatus and
// the consolidate page's `?view=run` when a skipped cycle is opened directly.

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";

import { skipCycleAction, unskipCycleAction } from "./skip-actions";

type SkipFormProps = {
  accountId: number;
  cycle: string;
  // `linkLabel` is the clickable surface text for the pending-row case.
  linkLabel?: string;
};

export function SkipCycleButton({ accountId, cycle, linkLabel = "Omitir" }: SkipFormProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    const fd = new FormData();
    fd.set("accountId", String(accountId));
    fd.set("cycle", cycle);
    if (reason.trim()) fd.set("reason", reason.trim());
    startTransition(async () => {
      try {
        await skipCycleAction(fd);
        toast.success(`Ciclo ${cycle} omitido — no volverá a aparecer en alertas.`);
        setOpen(false);
        setReason("");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "No se pudo omitir el ciclo.");
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <button
          type="button"
          data-testid={`skip-cycle-open-${cycle}`}
          className="text-muted-foreground hover:text-foreground text-xs underline"
        >
          {linkLabel}
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Marcar {cycle} como omitido</AlertDialogTitle>
          <AlertDialogDescription>
            No volverá a aparecer en alertas ni en el banner. Podés deshacerlo después desde esta
            misma lista si cambiás de opinión.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2">
          <label htmlFor={`skip-reason-${cycle}`} className="text-sm font-medium">
            Motivo (opcional)
          </label>
          <textarea
            id={`skip-reason-${cycle}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ej: no tengo el extracto archivado / ya cuadré vía ajuste de saldo"
            maxLength={500}
            rows={3}
            disabled={pending}
            className="border-input focus-visible:ring-ring rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-0 focus-visible:outline-none"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={pending}
          >
            {pending ? "Omitiendo…" : "Omitir ciclo"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type UnskipProps = {
  accountId: number;
  cycle: string;
  // Accept the same `buttonVariants` levers as the other inline CTAs in this
  // surface so callers can match local visual weight (e.g. `"outline"` +
  // `"sm"` for the page banner, a muted underline for list rows).
  asButton?: boolean;
};

export function UnskipCycleLink({ accountId, cycle, asButton = false }: UnskipProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleClick() {
    const fd = new FormData();
    fd.set("accountId", String(accountId));
    fd.set("cycle", cycle);
    startTransition(async () => {
      try {
        await unskipCycleAction(fd);
        toast.success(`Ciclo ${cycle} restaurado — vuelve a aparecer como pendiente.`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "No se pudo deshacer el skip.");
      }
    });
  }

  if (asButton) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleClick}
        disabled={pending}
        data-testid={`unskip-cycle-${cycle}`}
      >
        {pending ? "Deshaciendo…" : "Deshacer omisión"}
      </Button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending}
      data-testid={`unskip-cycle-${cycle}`}
      className={buttonVariants({ variant: "link", size: "sm" })}
    >
      {pending ? "Deshaciendo…" : "Deshacer"}
    </button>
  );
}
