import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AiClassifyButton } from "@/components/transactions/ai-classify-button";
import { Filters } from "@/components/transactions/filters";
import { TransactionTable } from "@/components/transactions/transaction-table";
import {
  countTotal,
  countUnclassified,
  listAccounts,
  listCategories,
  listCounterparties,
  listTransactions,
  PAGE_SIZE,
} from "@/lib/transactions/queries";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{
  from?: string;
  to?: string;
  accountId?: string;
  categorySlug?: string;
  q?: string;
  cursor?: string;
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

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;

  const accountId = sp.accountId ? Number(sp.accountId) : undefined;
  const filters = {
    from: sp.from,
    to: sp.to,
    accountId: Number.isFinite(accountId) ? accountId : undefined,
    categorySlug: sp.categorySlug,
    q: sp.q,
    cursor: sp.cursor,
  };

  const [
    { rows, nextCursor },
    accounts,
    categories,
    total,
    unclassified,
    allCounterparties,
  ] = await Promise.all([
    listTransactions(filters),
    listAccounts(),
    listCategories(),
    countTotal({
      from: filters.from,
      to: filters.to,
      accountId: filters.accountId,
      categorySlug: filters.categorySlug,
      q: filters.q,
    }),
    countUnclassified(),
    listCounterparties(),
  ]);

  const baseQuery = {
    from: sp.from,
    to: sp.to,
    accountId: sp.accountId,
    categorySlug: sp.categorySlug,
    q: sp.q,
  };

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-6">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-h1">Transactions</h1>
          <p className="text-body text-muted-foreground">
            {total.toLocaleString()} total · {unclassified.toLocaleString()} unclassified · showing up to {PAGE_SIZE} per page
          </p>
        </div>
        <AiClassifyButton unclassified={unclassified} />
      </header>

      <Filters
        accounts={accounts}
        categories={categories}
        values={{
          from: sp.from,
          to: sp.to,
          accountId: sp.accountId,
          categorySlug: sp.categorySlug,
          q: sp.q,
        }}
      />

      <TransactionTable
        rows={rows}
        categories={categories}
        allCounterparties={allCounterparties}
      />

      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
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
