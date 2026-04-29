import Link from "next/link";
import { AlertTriangleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AiClassifyButton,
  DrainAllPendingButton,
} from "@/components/transactions/ai-classify-button";
import { Filters } from "@/components/transactions/filters";
import { TransactionTable } from "@/components/transactions/transaction-table";
import { TransferGroupDialog } from "@/components/transactions/transfer-group-dialog";
import { getSessionUser } from "@/lib/auth/session";
import {
  countNeedingRate,
  countTotal,
  countUnclassified,
  listAccounts,
  listCategories,
  listCounterparties,
  listTransactions,
  PAGE_SIZE,
} from "@/lib/transactions/queries";
import { listActiveRecurrings } from "@/app/(app)/transactions/actions";
import { loadAmbiguousReceiptsForTxIds } from "@/lib/gmail/ambiguous";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "transactions/page" });

export const dynamic = "force-dynamic";

type SearchParams = Promise<{
  from?: string;
  to?: string;
  accountId?: string;
  categorySlug?: string;
  q?: string;
  cursor?: string;
  highlight?: string;
  showAdjustments?: string;
  showArchived?: string;
  needsRate?: string;
}>;

function buildHref(base: Record<string, string | undefined>, cursor: string | null) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) {
    if (v) params.set(k, v);
  }
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString();
  return qs ? `/transactions?${qs}` : "/transactions";
}

export default async function TransactionsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const session = await getSessionUser();

  const accountId = sp.accountId ? Number(sp.accountId) : undefined;
  const highlightRaw = sp.highlight ? Number(sp.highlight) : undefined;
  const highlightId = Number.isFinite(highlightRaw) ? highlightRaw : undefined;
  const hideAdjustments = !sp.showAdjustments;
  const includeArchived = Boolean(sp.showArchived);
  const needsRateActive = Boolean(sp.needsRate);
  const filters = {
    from: sp.from,
    to: sp.to,
    accountId: Number.isFinite(accountId) ? accountId : undefined,
    categorySlug: sp.categorySlug,
    q: sp.q,
    cursor: sp.cursor,
    hideAdjustments,
    includeArchived,
    needsRate: needsRateActive,
  };

  const [
    { rows, nextCursor },
    accounts,
    categories,
    total,
    unclassified,
    allCounterparties,
    needingRate,
    activeRecurrings,
  ] = await Promise.all([
    listTransactions(session.id, filters),
    listAccounts(session.id),
    listCategories(session.id),
    countTotal(session.id, {
      from: filters.from,
      to: filters.to,
      accountId: filters.accountId,
      categorySlug: filters.categorySlug,
      q: filters.q,
      includeArchived,
      needsRate: needsRateActive,
    }),
    countUnclassified(session.id),
    listCounterparties(session.id),
    countNeedingRate(session.id),
    listActiveRecurrings(),
  ]);

  // #455 (Epic G): sidecar query — attach ambiguous Gmail receipts to each
  // row without touching listTransactions (keeps it pure). The Map is keyed
  // by tx.id; rows without matches get undefined (undefined is stripped by
  // JSON serialization, matching the optional field on TxRow).
  // Failure here degrades to "no badges" — it must NOT crash the primary view.
  const txIds = rows.map((r) => r.id);
  let ambiguousMap: Awaited<ReturnType<typeof loadAmbiguousReceiptsForTxIds>> = new Map();
  try {
    ambiguousMap = await loadAmbiguousReceiptsForTxIds(session.id, txIds);
  } catch (err) {
    log.error(
      { err, event: "gmail_ambiguous_load_failed", userId: session.id, txCount: rows.length },
      "gmail ambiguous sidecar failed — degrading to no badges",
    );
  }
  if (ambiguousMap.size > 0) {
    for (const row of rows) {
      const receipts = ambiguousMap.get(row.id);
      if (receipts && receipts.length > 0) {
        row.gmailAmbiguousReceipts = receipts;
      }
    }
  }

  const baseQuery = {
    from: sp.from,
    to: sp.to,
    accountId: sp.accountId,
    categorySlug: sp.categorySlug,
    q: sp.q,
    showAdjustments: sp.showAdjustments,
    showArchived: sp.showArchived,
    needsRate: sp.needsRate,
  };

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-h1">Transactions</h1>
          <p className="text-body text-muted-foreground">
            {total.toLocaleString()} total · {unclassified.toLocaleString()} unclassified
            {hideAdjustments ? " · balance adjustments hidden" : null}
            {!includeArchived ? " · archived hidden" : " · archived included"} · showing up to{" "}
            {PAGE_SIZE} per page
          </p>
        </div>
        <div className="flex items-center gap-2">
          <TransferGroupDialog accounts={accounts} />
          <AiClassifyButton unclassified={unclassified} />
          <DrainAllPendingButton unclassified={unclassified} />
        </div>
      </header>

      <Filters accounts={accounts} categories={categories} />

      {needingRate > 0 && !needsRateActive ? (
        <div className="flex flex-col gap-1 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 dark:border-amber-900 dark:bg-amber-950/40">
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangleIcon className="mt-0.5 size-4 text-amber-700 dark:text-amber-400" />
            <div>
              <strong className="font-medium text-amber-900 dark:text-amber-200">
                {needingRate.toLocaleString()} {needingRate === 1 ? "compra" : "compras"} a cuotas
                sin tasa EM
              </strong>
              <span className="text-amber-800 dark:text-amber-300">
                {" "}
                — los intereses causados del ciclo no se van a calcular hasta que las completes.
                Mirá el extracto del mes.
              </span>
            </div>
          </div>
          <Button asChild variant="outline" size="sm" className="shrink-0">
            <Link href="/transactions?needsRate=on">Ver y completar</Link>
          </Button>
        </div>
      ) : null}

      <TransactionTable
        rows={rows}
        categories={categories}
        allCounterparties={allCounterparties}
        highlightId={highlightId}
        activeRecurrings={activeRecurrings}
      />

      <div className="flex items-center justify-between">
        <div className="text-muted-foreground text-xs">
          {sp.cursor ? (
            <Link href={buildHref(baseQuery, null)} className="underline">
              ← First page
            </Link>
          ) : null}
        </div>
        {nextCursor ? (
          <Button asChild variant="outline">
            <Link href={buildHref(baseQuery, nextCursor)}>Next page →</Link>
          </Button>
        ) : null}
      </div>
    </main>
  );
}
