"use client";

import { useEffect, useMemo } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ReceiptTextIcon, UserIcon, BuildingIcon, WrenchIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useNewIds } from "@/lib/hooks/use-new-ids";
import { hasSecondaryDescription, primaryDescription } from "@/lib/transactions/description";
import type { CounterpartyBrief, TxRow } from "@/lib/transactions/queries";
import { CategoryCell, type CategoryOption } from "./category-cell";
import { CounterpartyDialog } from "./counterparty-dialog";

const ROW_CLASSES =
  "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted";

const sourceLabel: Record<TxRow["source"], string> = {
  apple_pay: "Apple Pay",
  sms: "SMS",
  ocr: "OCR",
  csv: "CSV",
  recurring: "Recurring",
  manual: "Manual",
  telegram: "Telegram",
  balance_adjustment: "Ajuste",
};

const methodVariant: Record<
  TxRow["classificationMethod"],
  "default" | "secondary" | "outline" | "destructive"
> = {
  rule: "default",
  ai: "secondary",
  manual: "outline",
  unclassified: "destructive",
};

function AdjustmentBadge() {
  return (
    <Badge
      variant="outline"
      className="shrink-0 gap-1 border-slate-300 text-[10px] font-medium tracking-wide uppercase"
      title="Ajuste de saldo — reconciliación, excluido del spend"
    >
      <WrenchIcon className="size-2.5" />
      Ajuste
    </Badge>
  );
}

function CounterpartyTypeBadge({ type }: { type: NonNullable<TxRow["counterparty"]>["type"] }) {
  if (type === "person") {
    return (
      <span
        className="bg-muted text-muted-foreground inline-flex size-4 items-center justify-center rounded-full"
        title="Person"
      >
        <UserIcon className="size-2.5" />
      </span>
    );
  }
  if (type === "merchant") {
    return (
      <span
        className="bg-muted text-muted-foreground inline-flex size-4 items-center justify-center rounded-full"
        title="Merchant"
      >
        <BuildingIcon className="size-2.5" />
      </span>
    );
  }
  return null;
}

function formatAmount(cents: bigint, currency: TxRow["currency"]) {
  const n = Number(cents) / 100;
  const formatter = new Intl.NumberFormat(currency === "USD" ? "en-US" : "es-CO", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "USD" ? 2 : 0,
  });
  return formatter.format(n);
}

function formatDate(d: Date) {
  return d
    .toLocaleDateString("es-CO", {
      year: "numeric",
      month: "short",
      day: "2-digit",
    })
    .replace(/\sde\s/g, " ");
}

export function TransactionTable({
  rows,
  categories,
  allCounterparties,
  highlightId,
}: {
  rows: TxRow[];
  categories: CategoryOption[];
  allCounterparties: CounterpartyBrief[];
  highlightId?: number;
}) {
  const shouldReduceMotion = useReducedMotion();
  const rowIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const newIds = useNewIds(rowIds);
  const enterInitial = shouldReduceMotion ? false : { opacity: 0, y: -8 };
  const enterAnimate = { opacity: 1, y: 0 };
  const enterTransition = { duration: 0.25, ease: "easeOut" as const };

  useEffect(() => {
    if (highlightId === undefined) return;
    const els = document.querySelectorAll<HTMLElement>(`[data-highlight-row="${highlightId}"]`);
    for (const el of els) {
      if (el.offsetParent !== null) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        break;
      }
    }
  }, [highlightId]);

  if (rows.length === 0) {
    return (
      <div className="bg-card rounded-md border">
        <EmptyState
          icon={<ReceiptTextIcon />}
          title="No transactions"
          description="Nothing matches the current filters. Adjust the date range or clear a filter to see more."
        />
      </div>
    );
  }

  return (
    <>
      <div className="bg-card hidden rounded-md border md:block">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[116px] px-4">Date</TableHead>
              <TableHead className="px-4">Description</TableHead>
              <TableHead className="w-[256px] px-4">Category</TableHead>
              <TableHead className="w-[156px] px-4 text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <AnimatePresence initial={false}>
              {rows.map((tx) => {
                const isExpense = tx.amountCents < BigInt(0);
                const isNew = newIds.has(tx.id);
                const isHighlighted = tx.id === highlightId;
                const isUnclassified = tx.classificationMethod === "unclassified";
                return (
                  <motion.tr
                    key={tx.id}
                    data-slot="table-row"
                    data-highlight-row={isHighlighted ? tx.id : undefined}
                    className={cn(ROW_CLASSES, (isNew || isHighlighted) && "tx-row-new")}
                    initial={enterInitial}
                    animate={enterAnimate}
                    transition={enterTransition}
                  >
                    <TableCell
                      className="text-muted-foreground px-4 text-sm"
                      suppressHydrationWarning
                    >
                      {formatDate(tx.occurredAt)}
                    </TableCell>
                    <TableCell className="px-4">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-medium">{primaryDescription(tx)}</span>
                        {tx.isAdjustment ? <AdjustmentBadge /> : null}
                        {tx.counterparty ? (
                          <CounterpartyTypeBadge type={tx.counterparty.type} />
                        ) : null}
                        {tx.counterparty ? (
                          <CounterpartyDialog
                            counterparty={tx.counterparty}
                            categories={categories}
                            allCounterparties={allCounterparties}
                          />
                        ) : null}
                      </div>
                      <div className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
                        <span className="truncate">{tx.accountName}</span>
                        <span aria-hidden="true">·</span>
                        <span className="shrink-0">{sourceLabel[tx.source]}</span>
                        <span aria-hidden="true">·</span>
                        <span
                          className={cn(
                            "shrink-0",
                            isUnclassified && "text-destructive font-medium",
                          )}
                        >
                          {tx.classificationMethod}
                        </span>
                        {hasSecondaryDescription(tx) ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="truncate">{tx.descriptionRaw}</span>
                          </>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="px-4">
                      <CategoryCell txId={tx.id} value={tx.categorySlug} options={categories} />
                    </TableCell>
                    <TableCell
                      className={cn(
                        "money px-4 text-right font-medium",
                        isExpense ? "text-destructive" : "text-emerald-600",
                      )}
                      suppressHydrationWarning
                    >
                      {formatAmount(tx.amountCents, tx.currency)}
                    </TableCell>
                  </motion.tr>
                );
              })}
            </AnimatePresence>
          </TableBody>
        </Table>
      </div>

      <ul className="flex flex-col gap-2 md:hidden">
        <AnimatePresence initial={false}>
          {rows.map((tx) => {
            const isExpense = tx.amountCents < BigInt(0);
            const isNew = newIds.has(tx.id);
            const isHighlighted = tx.id === highlightId;
            return (
              <motion.li
                key={tx.id}
                data-highlight-row={isHighlighted ? tx.id : undefined}
                className={cn(
                  "bg-card flex flex-col gap-2 rounded-md border p-3",
                  (isNew || isHighlighted) && "tx-row-new",
                )}
                initial={enterInitial}
                animate={enterAnimate}
                transition={enterTransition}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{primaryDescription(tx)}</span>
                      {tx.isAdjustment ? <AdjustmentBadge /> : null}
                      {tx.counterparty ? (
                        <CounterpartyTypeBadge type={tx.counterparty.type} />
                      ) : null}
                      {tx.counterparty ? (
                        <CounterpartyDialog
                          counterparty={tx.counterparty}
                          categories={categories}
                          allCounterparties={allCounterparties}
                        />
                      ) : null}
                    </div>
                    {hasSecondaryDescription(tx) ? (
                      <p className="text-muted-foreground line-clamp-1 text-xs">
                        {tx.descriptionRaw}
                      </p>
                    ) : null}
                  </div>
                  <span
                    className={`money shrink-0 text-right text-sm font-semibold ${
                      isExpense ? "text-destructive" : "text-emerald-600"
                    }`}
                    suppressHydrationWarning
                  >
                    {formatAmount(tx.amountCents, tx.currency)}
                  </span>
                </div>

                <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span suppressHydrationWarning>{formatDate(tx.occurredAt)}</span>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">{tx.accountName}</span>
                  <span aria-hidden="true">·</span>
                  <Badge variant="outline" className="font-normal">
                    {sourceLabel[tx.source]}
                  </Badge>
                  <Badge variant={methodVariant[tx.classificationMethod]} className="font-normal">
                    {tx.classificationMethod}
                  </Badge>
                </div>

                <CategoryCell txId={tx.id} value={tx.categorySlug} options={categories} />
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </>
  );
}
