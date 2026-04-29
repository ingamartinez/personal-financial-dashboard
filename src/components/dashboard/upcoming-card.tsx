"use client";

// #632: UpcomingCard redesign.
// Changes from original:
//   - Data comes from getUpcomingForWindow (window-based, cross-month) instead of
//     getUpcomingForMonth — only un-matched slots are shown.
//   - Fixed-height with internal scroll to match TopExpensesCard sibling.
//   - Single "Asociar" trigger per row opens ForecastLinkTxDialog (unified dialog).
//   - dismissUpcoming / undismissUpcoming / promoteUpcoming buttons removed.
//   - "No pagué" and "Pagué" are accessible via ForecastRowActions in /transactions.

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Money } from "@/components/display/money";
import { cn } from "@/lib/utils";
import { ForecastLinkTxDialog } from "@/components/transactions/forecast-link-tx-dialog";
import type { UpcomingItem } from "@/lib/recurring/upcoming";
import type { Currency } from "@/lib/types";

export type UpcomingCardItem = Omit<UpcomingItem, "amountCents"> & {
  amountCents: string;
};

const dateFmt = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "short",
});

const statusStyles: Record<UpcomingItem["status"], string> = {
  upcoming: "bg-sky-100 text-sky-800",
  overdue: "bg-rose-100 text-rose-800",
  matched: "bg-emerald-100 text-emerald-800",
  dismissed: "bg-muted text-muted-foreground",
};

const statusLabels: Record<UpcomingItem["status"], string> = {
  upcoming: "pendiente",
  overdue: "atrasado",
  matched: "pagado",
  dismissed: "omitido",
};

type DialogSlot = {
  recurringId: number;
  yearMonth: string;
  label: string;
  amountCents: bigint;
  currency: Currency;
};

export function UpcomingCard({
  items,
  windowLabel,
}: {
  items: UpcomingCardItem[];
  /** e.g. "±5d desde hoy" */
  windowLabel?: string;
}) {
  const router = useRouter();
  const [dialogSlot, setDialogSlot] = useState<DialogSlot | null>(null);

  function openDialog(item: UpcomingCardItem) {
    setDialogSlot({
      recurringId: item.recurringId,
      yearMonth: item.yearMonth,
      label: item.label,
      amountCents: BigInt(item.amountCents),
      currency: item.currency,
    });
  }

  return (
    <>
      <Card className="flex flex-col">
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <div>
            <CardDescription>
              Próximos recurrentes{windowLabel ? ` · ${windowLabel}` : ""}
            </CardDescription>
            <CardTitle className="text-lg">Forecast</CardTitle>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/recurring">Gestionar</Link>
          </Button>
        </CardHeader>
        {/* Fixed height with internal scroll to match TopExpensesCard */}
        <CardContent className="min-h-0 flex-1">
          {items.length === 0 ? (
            <p className="text-muted-foreground py-4 text-center text-sm">
              Sin recurrentes pendientes en la ventana de ±5 días.{" "}
              <Link href="/settings/recurring" className="underline underline-offset-2">
                Agregar
              </Link>
            </p>
          ) : (
            <ul className="max-h-72 overflow-y-auto flex flex-col divide-y">
              {items.map((item) => {
                const cents = BigInt(item.amountCents);
                return (
                  <li
                    key={`${item.recurringId}-${item.yearMonth}`}
                    className="flex items-center gap-3 py-2 text-sm"
                  >
                    <div className="text-muted-foreground flex w-12 flex-col items-center text-xs">
                      <span className="font-medium">
                        {dateFmt.format(new Date(`${item.expectedOn}T12:00:00Z`))}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{item.label}</span>
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-[10px] tracking-wide uppercase",
                            statusStyles[item.status],
                          )}
                        >
                          {statusLabels[item.status]}
                        </span>
                      </div>
                      <div className="text-muted-foreground truncate text-xs">
                        {item.accountName}
                        {item.categoryName ? ` · ${item.categoryName}` : ""}
                      </div>
                    </div>
                    <div
                      className={cn(
                        "w-28 text-right font-medium tabular-nums",
                        cents < BigInt(0) ? "text-rose-600" : "text-emerald-600",
                      )}
                    >
                      <Money cents={cents} currency={item.currency} />
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openDialog(item)}
                      aria-label={`Asociar tx a ${item.label}`}
                      title="Asociar transacción existente"
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <LinkIcon className="size-4" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {dialogSlot ? (
        <ForecastLinkTxDialog
          open={dialogSlot !== null}
          onOpenChange={(next) => {
            if (!next) setDialogSlot(null);
          }}
          recurringId={dialogSlot.recurringId}
          yearMonth={dialogSlot.yearMonth}
          label={dialogSlot.label}
          expectedAmountCents={dialogSlot.amountCents}
          currency={dialogSlot.currency}
          onLinked={() => {
            setDialogSlot(null);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
