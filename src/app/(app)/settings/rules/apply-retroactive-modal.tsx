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
import { applyRuleRetroactive, type RulePreview } from "./actions";

type Props = {
  open: boolean;
  ruleId: number | null;
  preview: RulePreview | null;
  targetCategoryName: string | null;
  categoryName: (slug: string) => string;
  onClose: () => void;
};

function formatCop(amountCents: string): string {
  const n = Number(amountCents) / 100;
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  return `${sign}$${abs.toLocaleString("es-CO", { maximumFractionDigits: 0 })}`;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("es-CO", { day: "2-digit", month: "short" });
}

export function ApplyRetroactiveModal({
  open,
  ruleId,
  preview,
  targetCategoryName,
  categoryName,
  onClose,
}: Props) {
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    if (ruleId === null) return;
    startTransition(async () => {
      const result = await applyRuleRetroactive({ id: ruleId });
      if (result.status === "error") {
        toast.error(result.message);
        return;
      }
      toast.success(
        `Aplicado a ${result.updatedCount} ${result.updatedCount === 1 ? "transacción" : "transacciones"} pasada${result.updatedCount === 1 ? "" : "s"}`,
      );
      onClose();
    });
  }

  const count = preview?.matchCount ?? 0;
  const sample = preview?.sample ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Aplicar a {count} {count === 1 ? "transacción" : "transacciones"} pasada
            {count === 1 ? "" : "s"}?
          </DialogTitle>
          <DialogDescription>
            Encontramos {count} movimiento{count === 1 ? "" : "s"} de los últimos 90 días que
            coinciden con este patrón y están en otra categoría. Preservamos la categoría anterior
            por si querés revertir.
          </DialogDescription>
        </DialogHeader>

        {sample.length > 0 ? (
          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 text-muted-foreground uppercase">
                <tr>
                  <th className="p-2 text-left">Fecha</th>
                  <th className="p-2 text-left">Comercio</th>
                  <th className="p-2 text-left">Actual</th>
                  <th className="p-2 text-right">Monto</th>
                </tr>
              </thead>
              <tbody>
                {sample.map((row) => (
                  <tr key={row.id} className="border-t">
                    <td className="text-muted-foreground p-2">{shortDate(row.occurredAt)}</td>
                    <td className="max-w-[180px] truncate p-2">
                      {row.merchant ?? row.descriptionClean ?? "—"}
                    </td>
                    <td className="text-muted-foreground p-2">
                      {categoryName(row.currentCategorySlug)}
                    </td>
                    <td className="p-2 text-right tabular-nums">{formatCop(row.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {count > sample.length ? (
              <div className="text-muted-foreground border-t p-2 text-center text-xs">
                … y {count - sample.length} más
              </div>
            ) : null}
          </div>
        ) : null}

        {targetCategoryName ? (
          <p className="text-muted-foreground text-xs">
            Destino: <span className="text-foreground font-medium">{targetCategoryName}</span>
          </p>
        ) : null}

        <DialogFooter className="mt-2 flex-col-reverse gap-2 sm:flex-row">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={pending}
            data-testid="skip-retroactive"
          >
            No, solo hacia adelante
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            data-testid="confirm-retroactive"
          >
            {pending ? "Aplicando…" : "Confirmar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
