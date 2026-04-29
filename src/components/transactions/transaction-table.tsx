"use client";

import { useEffect, useMemo } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArchiveIcon,
  CalendarClockIcon,
  ReceiptTextIcon,
  RefreshCwIcon,
  UserIcon,
  BuildingIcon,
  WrenchIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/display/money";
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
import { ClassificationReasonDialog } from "./classification-reason-dialog";
import { ConfidenceBadge, confidenceBand } from "./confidence-badge";
import { CounterpartyDialog } from "./counterparty-dialog";
import { NeedsReviewBadge } from "./needs-review-badge";
import { TransactionRowActions } from "./transaction-row-actions";
import { ForecastRowActions } from "./forecast-row-actions";
import type { RecurringOption } from "@/app/(app)/transactions/link-recurring-types";
import type { ForecastOccurrence } from "@/app/(app)/transactions/forecast-actions";
import type { OccurrenceStatus } from "@/lib/recurring/expected-occurrences";

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
  csv_reconcile: "CSV (recon)",
  gmail_bancolombia: "Email BC",
  gmail_enrichment: "Email",
  gmail_arq: "Email ARQ",
  arq_statement: "ARQ Statement",
};

const methodVariant: Record<
  TxRow["classificationMethod"],
  "default" | "secondary" | "outline" | "destructive"
> = {
  rule: "default",
  rule_retroactive: "default",
  ai: "secondary",
  manual: "outline",
  manual_confirmed: "outline",
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

function ArchivedBadge() {
  return (
    <Badge
      variant="outline"
      className="shrink-0 gap-1 border-amber-300 text-[10px] font-medium tracking-wide text-amber-700 uppercase dark:border-amber-700 dark:text-amber-300"
      title="Archived — excluded from balance and reports"
    >
      <ArchiveIcon className="size-2.5" />
      Archived
    </Badge>
  );
}

// #407: compact cuota progress badge. We don't currently know the "paid"
// index for the tx without running the schedule helper on render, so the
// MVP shows just the total `N cuotas` for N > 1 — enough for the user to
// spot financed purchases at a glance. Future iteration can compute
// paid/total via the schedule.
function InstallmentsBadge({ total }: { total: number }) {
  if (total <= 1) return null;
  return (
    <Badge
      variant="outline"
      className="shrink-0 gap-1 border-indigo-300 text-[10px] font-medium tracking-wide text-indigo-700 uppercase dark:border-indigo-700 dark:text-indigo-300"
      title={`Financiado a ${total} cuotas`}
    >
      {total} cuotas
    </Badge>
  );
}

// #621: badge shown when a tx is linked to a recurring.
function RecurringBadge({ label }: { label: string | null }) {
  return (
    <Badge
      variant="outline"
      className="shrink-0 gap-1 border-violet-300 text-[10px] font-medium tracking-wide text-violet-700 uppercase dark:border-violet-700 dark:text-violet-300"
      title={`Recurring: ${label ?? "linked"}`}
    >
      <RefreshCwIcon className="size-2.5" />
      {label ? <span className="max-w-[80px] truncate">{label}</span> : "Recurring"}
    </Badge>
  );
}

// #622: badge shown on forecast rows indicating their status.
const forecastStatusConfig: Record<OccurrenceStatus, { label: string; className: string }> = {
  esperado: {
    label: "Esperado",
    className: "border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-400",
  },
  atrasado: {
    label: "Atrasado",
    className: "border-rose-300 text-rose-700 dark:border-rose-700 dark:text-rose-400",
  },
  skipped: {
    label: "Saltado",
    className:
      "border-slate-300 text-slate-400 line-through dark:border-slate-600 dark:text-slate-500",
  },
  linkeado: {
    label: "Linkeado",
    className: "border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400",
  },
  synthetic: {
    label: "Sintético",
    className: "border-blue-300 text-blue-700 dark:border-blue-700 dark:text-blue-400",
  },
};

function ForecastStatusBadge({ status }: { status: OccurrenceStatus }) {
  const config = forecastStatusConfig[status];
  return (
    <Badge
      variant="outline"
      className={cn(
        "shrink-0 gap-1 text-[10px] font-medium tracking-wide uppercase",
        config.className,
      )}
    >
      <CalendarClockIcon className="size-2.5" />
      {config.label}
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

function formatDate(d: Date) {
  return d
    .toLocaleDateString("es-CO", {
      year: "numeric",
      month: "short",
      day: "2-digit",
    })
    .replace(/\sde\s/g, " ");
}

// ---------------------------------------------------------------------------
// Merged row type — discriminated union of real tx vs forecast occurrence.
// ---------------------------------------------------------------------------

export type MergedRow =
  | { kind: "tx"; data: TxRow }
  | { kind: "forecast"; data: ForecastOccurrence };

/** Merge and sort real tx rows + forecast occurrences by date descending. */
export function mergeRows(txRows: TxRow[], forecasts: ForecastOccurrence[]): MergedRow[] {
  const txMapped: MergedRow[] = txRows.map((data) => ({ kind: "tx" as const, data }));

  // Filter out forecasts whose status is 'linkeado' or 'synthetic' — those
  // are already represented by a real tx row with the RecurringBadge.
  const forecastMapped: MergedRow[] = forecasts
    .filter((f) => f.status !== "linkeado" && f.status !== "synthetic")
    .map((data) => ({ kind: "forecast" as const, data }));

  const all = [...txMapped, ...forecastMapped];

  // Sort descending by date (same direction as the main tx list).
  all.sort((a, b) => {
    const aDate =
      a.kind === "tx" ? a.data.occurredAt.getTime() : new Date(a.data.expectedDateIso).getTime();
    const bDate =
      b.kind === "tx" ? b.data.occurredAt.getTime() : new Date(b.data.expectedDateIso).getTime();
    return bDate - aDate;
  });

  return all;
}

export function TransactionTable({
  rows,
  categories,
  allCounterparties,
  highlightId,
  activeRecurrings,
  forecastOccurrences = [],
}: {
  rows: TxRow[];
  categories: CategoryOption[];
  allCounterparties: CounterpartyBrief[];
  highlightId?: number;
  // #621: passed from the page to avoid per-row fetches.
  activeRecurrings: RecurringOption[];
  // #622: forecast occurrences to merge with real tx rows.
  forecastOccurrences?: ForecastOccurrence[];
}) {
  const shouldReduceMotion = useReducedMotion();
  const rowIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const newIds = useNewIds(rowIds);

  // Merge rows — real + forecast. Memoized to avoid re-sorting on every render.
  const mergedRows = useMemo(
    () => mergeRows(rows, forecastOccurrences),
    [rows, forecastOccurrences],
  );
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

  if (mergedRows.length === 0) {
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
              <TableHead className="w-[52px] px-2">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <AnimatePresence initial={false}>
              {mergedRows.map((row) => {
                // --------------- FORECAST ROW ---------------
                if (row.kind === "forecast") {
                  const fc = row.data;
                  const isExpense = fc.amountCents < BigInt(0);
                  const expectedDate = new Date(fc.expectedDateIso);
                  return (
                    <motion.tr
                      key={`forecast-${fc.recurringId}`}
                      data-slot="table-row"
                      data-testid="forecast-row"
                      className={cn(ROW_CLASSES, "bg-slate-50/60 dark:bg-slate-900/30")}
                      initial={enterInitial}
                      animate={enterAnimate}
                      transition={enterTransition}
                    >
                      <TableCell
                        className="text-muted-foreground px-4 text-sm italic"
                        suppressHydrationWarning
                      >
                        {formatDate(expectedDate)}
                      </TableCell>
                      <TableCell className="px-4">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="text-muted-foreground truncate font-medium italic">
                            {fc.label}
                          </span>
                          <ForecastStatusBadge status={fc.status} />
                        </div>
                        <div className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
                          <span className="truncate">{fc.accountName}</span>
                          <span aria-hidden="true">·</span>
                          <span className="shrink-0 italic">Recurring</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground px-4 text-sm italic">
                        {fc.categorySlug ?? "—"}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "money px-4 text-right font-medium italic opacity-60",
                          isExpense && "text-destructive",
                          !isExpense && "text-emerald-600",
                        )}
                        suppressHydrationWarning
                        title="Monto estimado — no suma al total del mes"
                      >
                        <Money cents={fc.amountCents} currency={fc.currency} />
                      </TableCell>
                      <TableCell className="px-2">
                        {fc.status !== "linkeado" &&
                        fc.status !== "synthetic" &&
                        fc.status !== "skipped" ? (
                          <ForecastRowActions
                            recurringId={fc.recurringId}
                            yearMonth={fc.expectedDateIso.slice(0, 7)}
                            label={fc.label}
                            expectedAmountCents={fc.amountCents}
                            currency={fc.currency}
                            expectedDateIso={fc.expectedDateIso}
                          />
                        ) : null}
                      </TableCell>
                    </motion.tr>
                  );
                }

                // --------------- REAL TX ROW ---------------
                const tx = row.data;
                const isExpense = tx.amountCents < BigInt(0);
                const isNew = newIds.has(tx.id);
                const isHighlighted = tx.id === highlightId;
                const isUnclassified = tx.classificationMethod === "unclassified";
                const isArchived = tx.deletedAt !== null;
                const isLowConfidence =
                  confidenceBand(tx.classificationMethod, tx.classificationConfidence) === "low";
                return (
                  <motion.tr
                    key={tx.id}
                    data-slot="table-row"
                    data-highlight-row={isHighlighted ? tx.id : undefined}
                    className={cn(
                      ROW_CLASSES,
                      (isNew || isHighlighted) && "tx-row-new",
                      isLowConfidence && !isArchived && "bg-rose-50/40 dark:bg-rose-950/15",
                      isArchived && "text-muted-foreground bg-muted/30 opacity-70",
                    )}
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
                        <span className={cn("truncate font-medium", isArchived && "line-through")}>
                          {primaryDescription(tx)}
                        </span>
                        {isArchived ? <ArchivedBadge /> : null}
                        {tx.isAdjustment ? <AdjustmentBadge /> : null}
                        {tx.accountType === "credit_card" && tx.installmentsTotal > 1 ? (
                          <InstallmentsBadge total={tx.installmentsTotal} />
                        ) : null}
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
                        {tx.gmailAmbiguousReceipts && tx.gmailAmbiguousReceipts.length > 0 ? (
                          <NeedsReviewBadge
                            receipts={tx.gmailAmbiguousReceipts}
                            transactionId={tx.id}
                            txDescription={primaryDescription(tx)}
                            txAmountCents={String(tx.amountCents)}
                            txOccurredAt={tx.occurredAt.toISOString()}
                          />
                        ) : null}
                        {tx.recurringId !== null ? (
                          <RecurringBadge label={tx.recurringLabel} />
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
                      <div className="flex flex-col gap-1">
                        <CategoryCell txId={tx.id} value={tx.categorySlug} options={categories} />
                        <div className="flex flex-wrap items-center gap-1">
                          <ConfidenceBadge
                            method={tx.classificationMethod}
                            confidence={tx.classificationConfidence}
                          />
                          <ClassificationReasonDialog
                            txId={tx.id}
                            method={tx.classificationMethod}
                          />
                        </div>
                      </div>
                    </TableCell>
                    <TableCell
                      className={cn(
                        "money px-4 text-right font-medium",
                        isExpense && !isArchived && "text-destructive",
                        !isExpense && !isArchived && "text-emerald-600",
                      )}
                      suppressHydrationWarning
                    >
                      <Money cents={tx.amountCents} currency={tx.currency} />
                    </TableCell>
                    <TableCell className="px-2">
                      <TransactionRowActions
                        txId={tx.id}
                        isArchived={isArchived}
                        accountType={tx.accountType}
                        amountCents={tx.amountCents}
                        currency={tx.currency}
                        installmentsTotal={tx.installmentsTotal}
                        installmentRateEmX10k={tx.installmentRateEmX10k}
                        recurringId={tx.recurringId}
                        recurringLabel={tx.recurringLabel}
                        activeRecurrings={activeRecurrings}
                      />
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
          {mergedRows.map((row) => {
            // --------------- FORECAST ROW (mobile) ---------------
            if (row.kind === "forecast") {
              const fc = row.data;
              const isExpense = fc.amountCents < BigInt(0);
              const expectedDate = new Date(fc.expectedDateIso);
              return (
                <motion.li
                  key={`forecast-${fc.recurringId}`}
                  data-testid="forecast-row-mobile"
                  className="flex flex-col gap-2 rounded-md border bg-slate-50 p-3 dark:bg-slate-900/30"
                  initial={enterInitial}
                  animate={enterAnimate}
                  transition={enterTransition}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-muted-foreground truncate font-medium italic">
                          {fc.label}
                        </span>
                        <ForecastStatusBadge status={fc.status} />
                      </div>
                      <p className="text-muted-foreground truncate text-xs">{fc.accountName}</p>
                    </div>
                    <div className="flex shrink-0 items-start gap-1">
                      <span
                        className={cn(
                          "money text-right text-sm font-semibold italic opacity-60",
                          isExpense && "text-destructive",
                          !isExpense && "text-emerald-600",
                        )}
                        suppressHydrationWarning
                        title="Monto estimado — no suma al total del mes"
                      >
                        <Money cents={fc.amountCents} currency={fc.currency} />
                      </span>
                      {fc.status !== "linkeado" &&
                      fc.status !== "synthetic" &&
                      fc.status !== "skipped" ? (
                        <ForecastRowActions
                          recurringId={fc.recurringId}
                          yearMonth={fc.expectedDateIso.slice(0, 7)}
                          label={fc.label}
                          expectedAmountCents={fc.amountCents}
                          currency={fc.currency}
                          expectedDateIso={fc.expectedDateIso}
                        />
                      ) : null}
                    </div>
                  </div>
                  <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs italic">
                    <span suppressHydrationWarning>{formatDate(expectedDate)}</span>
                    <span aria-hidden="true">·</span>
                    <span>Esperado</span>
                  </div>
                </motion.li>
              );
            }

            // --------------- REAL TX ROW (mobile) ---------------
            const tx = row.data;
            const isExpense = tx.amountCents < BigInt(0);
            const isNew = newIds.has(tx.id);
            const isHighlighted = tx.id === highlightId;
            const isArchived = tx.deletedAt !== null;
            return (
              <motion.li
                key={tx.id}
                data-highlight-row={isHighlighted ? tx.id : undefined}
                className={cn(
                  "bg-card flex flex-col gap-2 rounded-md border p-3",
                  (isNew || isHighlighted) && "tx-row-new",
                  isArchived && "text-muted-foreground bg-muted/30 opacity-70",
                )}
                initial={enterInitial}
                animate={enterAnimate}
                transition={enterTransition}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className={cn("truncate font-medium", isArchived && "line-through")}>
                        {primaryDescription(tx)}
                      </span>
                      {isArchived ? <ArchivedBadge /> : null}
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
                      {tx.gmailAmbiguousReceipts && tx.gmailAmbiguousReceipts.length > 0 ? (
                        <NeedsReviewBadge
                          receipts={tx.gmailAmbiguousReceipts}
                          transactionId={tx.id}
                          txDescription={primaryDescription(tx)}
                          txAmountCents={String(tx.amountCents)}
                          txOccurredAt={tx.occurredAt.toISOString()}
                        />
                      ) : null}
                      {tx.recurringId !== null ? (
                        <RecurringBadge label={tx.recurringLabel} />
                      ) : null}
                    </div>
                    {hasSecondaryDescription(tx) ? (
                      <p className="text-muted-foreground line-clamp-1 text-xs">
                        {tx.descriptionRaw}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-start gap-1">
                    <span
                      className={cn(
                        "money text-right text-sm font-semibold",
                        isExpense && !isArchived && "text-destructive",
                        !isExpense && !isArchived && "text-emerald-600",
                      )}
                      suppressHydrationWarning
                    >
                      <Money cents={tx.amountCents} currency={tx.currency} />
                    </span>
                    <TransactionRowActions
                      txId={tx.id}
                      isArchived={isArchived}
                      accountType={tx.accountType}
                      amountCents={tx.amountCents}
                      currency={tx.currency}
                      installmentsTotal={tx.installmentsTotal}
                      installmentRateEmX10k={tx.installmentRateEmX10k}
                      recurringId={tx.recurringId}
                      recurringLabel={tx.recurringLabel}
                      activeRecurrings={activeRecurrings}
                    />
                  </div>
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

                <div className="flex flex-col gap-1">
                  <CategoryCell txId={tx.id} value={tx.categorySlug} options={categories} />
                  <div className="flex flex-wrap items-center gap-1">
                    <ConfidenceBadge
                      method={tx.classificationMethod}
                      confidence={tx.classificationConfidence}
                    />
                    <ClassificationReasonDialog txId={tx.id} method={tx.classificationMethod} />
                  </div>
                </div>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </>
  );
}
