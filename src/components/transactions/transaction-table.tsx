import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { TxRow } from "@/lib/transactions/queries";
import { CategoryCell, type CategoryOption } from "./category-cell";

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

export function TransactionTable({
  rows,
  categories,
}: {
  rows: TxRow[];
  categories: CategoryOption[];
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border bg-card p-8 text-center text-sm text-muted-foreground">
        No transactions match the current filters.
      </div>
    );
  }

  return (
    <div className="rounded-md border bg-card">
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
                <TableCell className="text-muted-foreground">
                  {formatDate(tx.occurredAt)}
                </TableCell>
                <TableCell>
                  <div className="font-medium">
                    {tx.merchant ?? tx.descriptionClean ?? tx.descriptionRaw}
                  </div>
                  {tx.merchant || tx.descriptionClean ? (
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
                  className={`text-right text-money ${isExpense ? "text-destructive" : "text-emerald-600"}`}
                >
                  {formatAmount(tx.amountCents, tx.currency)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
