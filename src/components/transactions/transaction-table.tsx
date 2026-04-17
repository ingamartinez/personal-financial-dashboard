import { ReceiptTextIcon, UserIcon, BuildingIcon } from "lucide-react";
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
import type { CounterpartyBrief, TxRow } from "@/lib/transactions/queries";
import { CategoryCell, type CategoryOption } from "./category-cell";
import { CounterpartyDialog } from "./counterparty-dialog";

const sourceLabel: Record<TxRow["source"], string> = {
  apple_pay: "Apple Pay",
  sms: "SMS",
  ocr: "OCR",
  csv: "CSV",
  recurring: "Recurring",
  manual: "Manual",
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

function CounterpartyTypeBadge({
  type,
}: {
  type: NonNullable<TxRow["counterparty"]>["type"];
}) {
  if (type === "person") {
    return (
      <span
        className="inline-flex size-4 items-center justify-center rounded-full bg-muted text-muted-foreground"
        title="Person"
      >
        <UserIcon className="size-2.5" />
      </span>
    );
  }
  if (type === "merchant") {
    return (
      <span
        className="inline-flex size-4 items-center justify-center rounded-full bg-muted text-muted-foreground"
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
  return d.toLocaleDateString("es-CO", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

function primaryDescription(tx: TxRow): string {
  return (
    tx.counterparty?.displayName ??
    tx.merchant ??
    tx.descriptionClean ??
    tx.descriptionRaw
  );
}

function hasSecondaryDescription(tx: TxRow): boolean {
  return Boolean(tx.counterparty || tx.merchant || tx.descriptionClean);
}

export function TransactionTable({
  rows,
  categories,
  allCounterparties,
}: {
  rows: TxRow[];
  categories: CategoryOption[];
  allCounterparties: CounterpartyBrief[];
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border bg-card">
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
      <div className="hidden rounded-md border bg-card md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[110px]">Date</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="w-[150px]">Account</TableHead>
              <TableHead className="w-[200px]">Category</TableHead>
              <TableHead className="w-[110px]">Source</TableHead>
              <TableHead className="w-[110px]">Method</TableHead>
              <TableHead className="w-[140px] text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((tx) => {
              const isExpense = tx.amountCents < BigInt(0);
              return (
                <TableRow key={tx.id}>
                  <TableCell
                    className="text-muted-foreground"
                    suppressHydrationWarning
                  >
                    {formatDate(tx.occurredAt)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">
                        {primaryDescription(tx)}
                      </span>
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
                      <div className="text-xs text-muted-foreground line-clamp-1">
                        {tx.descriptionRaw}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {tx.accountName}
                  </TableCell>
                  <TableCell>
                    <CategoryCell
                      txId={tx.id}
                      value={tx.categorySlug}
                      options={categories}
                    />
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{sourceLabel[tx.source]}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={methodVariant[tx.classificationMethod]}>
                      {tx.classificationMethod}
                    </Badge>
                  </TableCell>
                  <TableCell
                    className={`text-right money ${isExpense ? "text-destructive" : "text-emerald-600"}`}
                    suppressHydrationWarning
                  >
                    {formatAmount(tx.amountCents, tx.currency)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <ul className="flex flex-col gap-2 md:hidden">
        {rows.map((tx) => {
          const isExpense = tx.amountCents < BigInt(0);
          return (
            <li
              key={tx.id}
              className="flex flex-col gap-2 rounded-md border bg-card p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium">
                      {primaryDescription(tx)}
                    </span>
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
                    <p className="line-clamp-1 text-xs text-muted-foreground">
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

              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span suppressHydrationWarning>{formatDate(tx.occurredAt)}</span>
                <span aria-hidden="true">·</span>
                <span className="truncate">{tx.accountName}</span>
                <span aria-hidden="true">·</span>
                <Badge variant="outline" className="font-normal">
                  {sourceLabel[tx.source]}
                </Badge>
                <Badge
                  variant={methodVariant[tx.classificationMethod]}
                  className="font-normal"
                >
                  {tx.classificationMethod}
                </Badge>
              </div>

              <CategoryCell
                txId={tx.id}
                value={tx.categorySlug}
                options={categories}
              />
            </li>
          );
        })}
      </ul>
    </>
  );
}
