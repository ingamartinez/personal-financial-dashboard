"use client";

import { useTransition } from "react";
import { WalletIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  markOccurrencePaidExternal,
  unmarkOccurrencePaidExternal,
} from "@/app/(app)/settings/recurring/actions";
import type { UpcomingStatus } from "@/lib/recurring/upcoming";

// ---------------------------------------------------------------------------
// #1034 — an occurrence paid from an account findash deliberately does not
// track. The state itself is derived server-side (src/lib/recurring/upcoming.ts
// and expected-occurrences.ts); these components only render it and offer the
// two-way toggle.
// ---------------------------------------------------------------------------

/**
 * yyyy-mm of the slot the /recurring surfaces render — the current UTC month,
 * the same month `getUpcomingForMonth` reports statuses for. Tests inject
 * `slotYearMonth` instead of relying on the clock.
 */
export function currentSlotYearMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Only a month that is still open can be marked: a matched slot already has a
 * real payment, a dismissed one did not happen, and a paid-external one is
 * already marked.
 */
export function canMarkPaidExternal(status: UpcomingStatus | undefined): boolean {
  return status !== "matched" && status !== "dismissed" && status !== "paid-external";
}

export function PaidExternalStateLine({ yearMonth }: { yearMonth: string }) {
  return (
    <p
      className="text-xs leading-snug text-violet-700 dark:text-violet-300"
      data-testid="paid-external-state"
    >
      Pagado desde una cuenta no registrada ({yearMonth}). No hay movimiento en findash y no lo va a
      haber.
    </p>
  );
}

interface PaidExternalToggleProps {
  recurringId: number;
  yearMonth: string;
  marked: boolean;
}

export function PaidExternalToggle({ recurringId, yearMonth, marked }: PaidExternalToggleProps) {
  const [pending, startTransition] = useTransition();

  const onToggle = () => {
    startTransition(async () => {
      try {
        if (marked) {
          await unmarkOccurrencePaidExternal({ recurringId, yearMonth });
          toast.success(`Reabierto ${yearMonth}`);
        } else {
          await markOccurrencePaidExternal({ recurringId, yearMonth });
          toast.success(`Marcado como pagado en cuenta externa (${yearMonth})`);
        }
      } catch (error) {
        toast.error("No se pudo actualizar el estado del mes", {
          description: error instanceof Error ? error.message : undefined,
        });
      }
    });
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="gap-1.5 self-start"
      disabled={pending}
      onClick={onToggle}
      data-testid="paid-external-toggle"
      aria-label={
        marked
          ? `Desmarcar pagado en cuenta externa (${yearMonth})`
          : `Marcar pagado en cuenta externa (${yearMonth})`
      }
    >
      <WalletIcon className="size-3.5" />
      {marked ? (pending ? "Desmarcando…" : "Desmarcar") : pending ? "Marcando…" : "Marcar pagado"}
    </Button>
  );
}
