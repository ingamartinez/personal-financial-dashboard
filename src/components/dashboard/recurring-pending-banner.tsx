// #622: Slim banner that replaces RecurringInboxCard on the dashboard.
// Renders only when there are pending recurring occurrences (open gaps or
// current-month atrasado/esperado not yet in a gap).
// Routes the user to /transactions for the current month to resolve them.

import Link from "next/link";
import { BellIcon } from "lucide-react";
import { countPendingOccurrences } from "@/lib/recurring/expected-occurrences";

export async function RecurringPendingBanner({ userId }: { userId: number }) {
  const today = new Date();
  const count = await countPendingOccurrences(userId, today);

  if (count === 0) return null;

  // Build link to /transactions for the current month.
  const ym = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;
  const [year, month] = ym.split("-");
  // First and last day of the month.
  const from = `${ym}-01`;
  const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  const to = `${ym}-${String(lastDay).padStart(2, "0")}`;
  const href = `/transactions?from=${from}&to=${to}`;

  return (
    <aside
      role="note"
      aria-label="Recurrentes pendientes"
      data-testid="recurring-pending-banner"
      className="flex flex-col gap-1 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 dark:border-amber-900 dark:bg-amber-950/40"
    >
      <div className="flex items-start gap-2 text-sm">
        <BellIcon className="mt-0.5 size-4 text-amber-700 dark:text-amber-400" />
        <div>
          <strong className="font-medium text-amber-900 dark:text-amber-200">
            {count === 1
              ? "Tenés 1 recurrente pendiente de resolver"
              : `Tenés ${count} recurrentes pendientes de resolver`}
          </strong>
          <span className="text-amber-800 dark:text-amber-300">
            {" "}
            — asociá o registrá los pagos en el mes actual.
          </span>
        </div>
      </div>
      <Link
        href={href}
        className="inline-flex items-center justify-center rounded-md border border-amber-400 bg-amber-100 px-3 py-1 text-xs font-medium whitespace-nowrap text-amber-900 hover:bg-amber-200 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-100 dark:hover:bg-amber-900/60"
      >
        Ir a transacciones
      </Link>
    </aside>
  );
}
