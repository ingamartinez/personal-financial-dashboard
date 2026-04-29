// #633: Learning proposals page — /settings/recurring/learning
// Lists pending recurring learning proposals (amount_update + variable_flag)
// and lets the user accept or reject each one.

import { and, eq, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { recurringProposals, recurringTransactions, accounts } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import { formatAccountLabel } from "@/lib/accounts/format";
import { RecurringProposalsList } from "./recurring-proposals-list";

export const dynamic = "force-dynamic";

export default async function RecurringLearningPage() {
  const session = await getSessionUser();

  const proposals = await db
    .select({
      id: recurringProposals.id,
      recurringId: recurringProposals.recurringId,
      label: recurringTransactions.label,
      accountName: accounts.name,
      accountCurrency: accounts.currency,
      proposalType: recurringProposals.proposalType,
      payload: recurringProposals.payload,
      createdAt: recurringProposals.createdAt,
    })
    .from(recurringProposals)
    .innerJoin(
      recurringTransactions,
      and(
        eq(recurringTransactions.id, recurringProposals.recurringId),
        // Tenant-safety: pair user_id on both sides.
        eq(recurringTransactions.userId, recurringProposals.userId),
      ),
    )
    .innerJoin(
      accounts,
      and(
        eq(accounts.id, recurringTransactions.accountId),
        // Tenant-safety on accounts JOIN.
        eq(accounts.userId, recurringProposals.userId),
      ),
    )
    .where(
      and(
        eq(recurringProposals.userId, session.id),
        eq(recurringProposals.status, "pending"),
        notDeleted(recurringTransactions.deletedAt),
      ),
    )
    .orderBy(desc(recurringProposals.createdAt));

  const formattedProposals = proposals.map((p) => ({
    id: p.id,
    recurringId: p.recurringId,
    label: p.label,
    accountLabel: formatAccountLabel({ name: p.accountName, currency: p.accountCurrency }),
    proposalType: p.proposalType as "amount_update" | "variable_flag",
    payload: p.payload as Record<string, unknown>,
    createdAt: p.createdAt.toISOString(),
  }));

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6 lg:p-10">
      <div className="flex flex-col gap-6">
        <header>
          <h1 className="text-2xl font-semibold">Aprendizaje de recurrentes</h1>
          <p className="text-ink-muted mt-1 text-sm">
            Findash detectó patrones en tus pagos. Confirmá o rechazá cada sugerencia.
          </p>
        </header>

        <RecurringProposalsList proposals={formattedProposals} />
      </div>
    </main>
  );
}
