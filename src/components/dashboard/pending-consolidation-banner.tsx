import Link from "next/link";
import { AlertTriangleIcon } from "lucide-react";

import { overdueCyclesForUser } from "@/lib/accounts/cycles";
import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { and, eq } from "drizzle-orm";

// Reads TC accounts + their cycle state and renders an amber banner when one
// or more cycles are past their cut day by more than the threshold. Intended
// to live at the top of the dashboard — shows nothing when the user is caught
// up, so it's zero UI cost on the happy path.
export async function PendingConsolidationBanner({
  userId,
  thresholdDays = 7,
}: {
  userId: number;
  thresholdDays?: number;
}) {
  const tcAccounts = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      metadata: accounts.metadata,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.type, "credit_card"),
        eq(accounts.institutionSlug, "bancolombia"),
        notDeleted(accounts.deletedAt),
      ),
    );
  if (tcAccounts.length === 0) return null;

  const overdue = await overdueCyclesForUser(userId, tcAccounts, { thresholdDays });
  if (overdue.length === 0) return null;

  const mostOverdue = overdue[0];
  const message =
    overdue.length === 1
      ? `Ciclo ${mostOverdue.cycle} de ${mostOverdue.accountName} está pendiente hace ${mostOverdue.daysOverdue} días.`
      : `Tenés ${overdue.length} ciclos TC sin consolidar — el más atrasado es ${mostOverdue.cycle} de ${mostOverdue.accountName} (+${mostOverdue.daysOverdue}d).`;

  const linkHref = `/settings/accounts/${mostOverdue.accountId}/consolidate/${mostOverdue.cycle}`;

  return (
    <aside
      role="note"
      aria-label="Ciclos pendientes de consolidación"
      data-testid="pending-consolidation-banner"
      className="flex flex-col gap-1 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 dark:border-amber-900 dark:bg-amber-950/40"
    >
      <div className="flex items-start gap-2 text-sm">
        <AlertTriangleIcon className="mt-0.5 size-4 text-amber-700 dark:text-amber-400" />
        <div>
          <strong className="font-medium text-amber-900 dark:text-amber-200">
            Ciclos TC sin consolidar
          </strong>
          <span className="text-amber-800 dark:text-amber-300"> — {message}</span>
        </div>
      </div>
      <Link
        href={linkHref}
        className="inline-flex items-center justify-center rounded-md border border-amber-400 bg-amber-100 px-3 py-1 text-xs font-medium whitespace-nowrap text-amber-900 hover:bg-amber-200 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-100 dark:hover:bg-amber-900/60"
      >
        Consolidar ahora
      </Link>
    </aside>
  );
}
