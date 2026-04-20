import { getSessionUser } from "@/lib/auth/session";
import { getBudgetsOverview } from "@/lib/budgets/queries";
import { BudgetsManager } from "./budgets-manager";

export const dynamic = "force-dynamic";

function currentYearMonth(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string }>;
}) {
  const session = await getSessionUser();
  const params = await searchParams;
  const ym = params.ym && /^\d{4}-\d{2}$/.test(params.ym) ? params.ym : currentYearMonth();

  const { categories: cats, items } = await getBudgetsOverview(session.id, ym);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Budgets</h1>
        <p className="text-body text-muted-foreground">
          Monthly spending caps per category. Each month starts fresh — no rollover. Progress tracks
          expenses (negative transactions) in the selected month.
        </p>
      </header>
      <BudgetsManager ym={ym} categories={cats} items={items} />
    </main>
  );
}
