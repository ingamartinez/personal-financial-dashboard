// #633: Slim banner that appears when there are pending recurring learning
// proposals. Links to /settings/recurring/learning for the user to review.

import Link from "next/link";
import { SparklesIcon } from "lucide-react";
import { countPendingProposals } from "@/app/(app)/settings/recurring/learning/actions";

export async function RecurringProposalsBanner({ userId }: { userId: number }) {
  const count = await countPendingProposals(userId);
  if (count === 0) return null;

  return (
    <aside
      role="note"
      aria-label="Sugerencias de aprendizaje"
      data-testid="recurring-proposals-banner"
      className="flex flex-col gap-1 rounded-md border border-blue-300 bg-blue-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 dark:border-blue-900 dark:bg-blue-950/40"
    >
      <div className="flex items-start gap-2 text-sm">
        <SparklesIcon className="mt-0.5 size-4 text-blue-700 dark:text-blue-400" />
        <div>
          <strong className="font-medium text-blue-900 dark:text-blue-200">
            {count === 1
              ? "Findash detectó 1 cambio en tus recurrentes"
              : `Findash detectó ${count} cambios en tus recurrentes`}
          </strong>
          <span className="text-blue-800 dark:text-blue-300">
            {" "}
            — revisá las sugerencias para mantener tus estimados al día.
          </span>
        </div>
      </div>
      <Link
        href="/settings/recurring/learning"
        className="inline-flex items-center justify-center rounded-md border border-blue-400 bg-blue-100 px-3 py-1 text-xs font-medium whitespace-nowrap text-blue-900 hover:bg-blue-200 dark:border-blue-700 dark:bg-blue-900/40 dark:text-blue-100 dark:hover:bg-blue-900/60"
      >
        Ver sugerencias
      </Link>
    </aside>
  );
}
