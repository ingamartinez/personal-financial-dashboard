"use client";

import { useState, useTransition } from "react";
import { HelpCircleIcon, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { classifySingleWithAi, updateTransactionCategory } from "@/app/(app)/transactions/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CategoryCombobox } from "./category-combobox";

export type CategoryOption = {
  slug: string;
  name: string;
  parentSlug: string | null;
};

// #682: Static explainer dialog for transfers. No server fetch needed —
// the explanation is model-level truth, not per-transaction.
function TransferCategoryExplanation() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-md border border-dashed px-1.5 py-0.5 text-[11px] font-normal"
          aria-label="¿Por qué no tiene categoría?"
          title="¿Por qué no tiene categoría?"
          data-testid="transfer-category-why"
        >
          <HelpCircleIcon className="size-3" />
          ¿Por qué?
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>¿Por qué no tiene categoría?</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>
                Esta transacción es una <strong>transferencia entre tus cuentas</strong> (por
                ejemplo, pago de tarjeta de crédito desde tu cuenta de ahorros).
              </p>
              <p>
                Las transferencias no llevan categoría porque no son ni gasto ni ingreso — solo{" "}
                <strong>movimiento de plata entre cuentas tuyas</strong>.
              </p>
              <p>
                Si pagaste una tarjeta de crédito, los gastos ya quedaron contados cuando hiciste
                las compras con la tarjeta. Contar el pago como gasto sería doble conteo.
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Entendido
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// #766: Static explainer for ATM cash withdrawals — same pattern as transfers.
function CashWithdrawalCategoryExplanation() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-md border border-dashed px-1.5 py-0.5 text-[11px] font-normal"
          aria-label="¿Por qué no tiene categoría?"
          title="¿Por qué no tiene categoría?"
          data-testid="cash-withdrawal-category-why"
        >
          <HelpCircleIcon className="size-3" />
          ¿Por qué?
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>¿Por qué no tiene categoría?</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>
                Este retiro de cajero automático saca plata de tu cuenta y la convierte en{" "}
                <strong>efectivo en tu billetera</strong> — no es un gasto.
              </p>
              <p>
                Cuando uses ese efectivo para pagar algo, el gasto se registra en ese momento (si
                ingresás la transacción manualmente). Contar el retiro como gasto generaría{" "}
                <strong>doble conteo</strong>.
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Entendido
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CategoryCell({
  txId,
  value,
  options,
  channel,
}: {
  txId: number;
  value: string | null;
  options: CategoryOption[];
  channel?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [aiPending, startAiTransition] = useTransition();
  const busy = pending || aiPending;
  const isUnclassified = value === null;

  // #682: transfers never carry a category by design — show a static badge
  // instead of the combobox + sparkles to avoid confusing the user.
  // #766: same for ATM cash withdrawals — money moves to wallet, not a spend.
  if (channel === "transfer") {
    return (
      <div className="flex items-center gap-1.5">
        <Badge variant="secondary" data-testid="transfer-category-badge">
          Transferencia
        </Badge>
        <TransferCategoryExplanation />
      </div>
    );
  }

  if (channel === "cash_withdrawal") {
    return (
      <div className="flex items-center gap-1.5">
        <Badge variant="secondary" data-testid="cash-withdrawal-category-badge">
          Retiro de efectivo
        </Badge>
        <CashWithdrawalCategoryExplanation />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <CategoryCombobox
        value={value}
        options={options}
        disabled={busy}
        onChange={(next) => {
          startTransition(async () => {
            try {
              await updateTransactionCategory({ txId, categorySlug: next });
              toast.success("Category updated");
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Failed to update");
            }
          });
        }}
        triggerClassName="h-8"
      />
      {isUnclassified ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          disabled={busy}
          aria-label="Classify with AI"
          title="Classify with AI"
          onClick={() => {
            startAiTransition(async () => {
              const res = await classifySingleWithAi({ txId });
              if (res.status === "error") {
                toast.error(res.message);
                return;
              }
              const pct = Math.round(res.confidence);
              if (pct < 50) {
                toast.warning(`Classified as ${res.categoryName} · low confidence (${pct}%)`);
              } else {
                toast.success(`Classified as ${res.categoryName} (${pct}%)`);
              }
            });
          }}
        >
          <Sparkles className={aiPending ? "size-4 animate-pulse" : "size-4"} />
        </Button>
      ) : null}
    </div>
  );
}
