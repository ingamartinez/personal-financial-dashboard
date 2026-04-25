"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLinkIcon } from "lucide-react";
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
import { formatMoney } from "@/lib/money";
import type { GmailAmbiguousReceipt } from "@/lib/types";
import type { Currency } from "@/lib/types";

// #455 (Epic G): human-readable display names for each gateway value.
// Plain text only — no logo assets in v1.
const GATEWAY_DISPLAY_NAME: Record<GmailAmbiguousReceipt["gateway"], string> = {
  mercado_pago: "Mercado Pago",
  payu: "PayU",
  wompi: "Wompi",
  apple: "Apple",
  paypal: "PayPal",
  bancolombia: "Bancolombia",
  arq: "ARQ",
};

function formatReceiptDate(iso: string): string {
  if (!iso) return "—";
  return new Date(iso)
    .toLocaleDateString("es-CO", {
      year: "numeric",
      month: "short",
      day: "2-digit",
    })
    .replace(/\sde\s/g, " ");
}

function formatReceiptMoney(amountCents: string, currency: string): string {
  try {
    return formatMoney(BigInt(amountCents), currency as Currency);
  } catch {
    return amountCents;
  }
}

export type DisambiguationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  receipts: GmailAmbiguousReceipt[];
  transactionId: number;
  txDescription: string;
  txAmountCents: string;
  txOccurredAt: string;
};

/**
 * #455 (Epic G): disambiguation dialog for transactions with ambiguous Gmail
 * receipt matches. The user picks one candidate ("Es este"), dismisses all
 * ("Ninguno coincide"), or cancels without committing.
 *
 * Raw email view: v1 uses a "Ver email original" link that opens the raw HTML
 * route in a new tab. The route enforces tenant isolation + CSP headers; the
 * browser handles rendering. An embedded iframe was deliberately skipped to
 * avoid CSS fighting inside the app shell.
 *
 * Optimistic UI: we hide the dialog instantly and let the parent's router
 * refresh reflect the DB change on the next server render. On error we
 * rollback by reopening and showing a toast.
 */
export function DisambiguationDialog({
  open,
  onOpenChange,
  receipts,
  transactionId,
  txDescription,
  txAmountCents,
  txOccurredAt,
}: DisambiguationDialogProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [localReceipts, setLocalReceipts] = useState(receipts);

  // We track receipts locally for optimistic removal while the server re-renders.
  const effectiveReceipts = localReceipts;

  async function handleConfirm(receiptId: number) {
    startTransition(async () => {
      // Optimistic: close immediately
      onOpenChange(false);
      try {
        const res = await fetch("/api/integrations/gmail/disambiguate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transactionId, receiptId, decision: "confirm" }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        toast.success("Merchant confirmado — el email quedó vinculado a la transacción.");
        // Refresh the server component so the badge clears on the re-render.
        router.refresh();
      } catch (err) {
        // Rollback: reopen the dialog
        onOpenChange(true);
        toast.error(
          `No se pudo confirmar el merchant: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  async function handleReject() {
    startTransition(async () => {
      onOpenChange(false);
      try {
        const res = await fetch("/api/integrations/gmail/disambiguate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transactionId, decision: "reject" }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        // Locally remove all receipts so the badge disappears instantly,
        // then refresh the server component for server-truth consistency.
        setLocalReceipts([]);
        router.refresh();
        toast.success("Candidatos descartados — esta transacción ya no tiene sugerencias.");
      } catch (err) {
        onOpenChange(true);
        toast.error(`No se pudo descartar: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  const txDate = formatReceiptDate(txOccurredAt);
  const txAmount = formatReceiptMoney(txAmountCents, "COP");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Confirma el merchant real</DialogTitle>
          <DialogDescription>
            Esta transacción tiene {effectiveReceipts.length} recibo
            {effectiveReceipts.length !== 1 ? "s" : ""} de email que podrían corresponder. Elegí
            cuál es el correcto o descartá todos.
          </DialogDescription>
        </DialogHeader>

        {/* Transaction summary */}
        <div className="bg-muted rounded-md px-4 py-3 text-sm">
          <p className="font-medium">{txDescription}</p>
          <p className="text-muted-foreground text-xs">
            {txDate} · {txAmount}
          </p>
        </div>

        {/* Candidate cards */}
        <div className="flex flex-col gap-3">
          {effectiveReceipts.map((receipt) => (
            <div
              key={receipt.id}
              className="flex items-start justify-between gap-3 rounded-md border p-3 text-sm"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium">{GATEWAY_DISPLAY_NAME[receipt.gateway]}</p>
                {receipt.merchant ? (
                  <p className="text-muted-foreground truncate text-xs">{receipt.merchant}</p>
                ) : null}
                <p className="text-muted-foreground text-xs">
                  {formatReceiptMoney(receipt.amountCents, receipt.currency)} ·{" "}
                  {formatReceiptDate(receipt.occurredAt)}
                </p>
                <a
                  href={`/api/integrations/gmail/receipts/${receipt.id}/raw`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary mt-1 inline-flex items-center gap-1 text-xs underline"
                >
                  Ver email original
                  <ExternalLinkIcon className="size-3" />
                </a>
              </div>
              <Button
                size="sm"
                variant="default"
                disabled={pending}
                onClick={() => handleConfirm(receipt.id)}
              >
                Es este
              </Button>
            </div>
          ))}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={handleReject}
            className="text-muted-foreground"
          >
            Ninguno coincide
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancelar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
