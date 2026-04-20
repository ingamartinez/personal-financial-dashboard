import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import { ReconcileForm } from "./reconcile-form";
import { FlaggedReview, type FlaggedRow, type MergeCandidate } from "./flagged-review";

export const dynamic = "force-dynamic";

export default async function ReconcilePage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const session = await getSessionUser();
  const { accountId: rawId } = await params;
  const accountId = Number(rawId);
  if (!Number.isInteger(accountId) || accountId <= 0) notFound();

  const [account] = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      institution: accounts.institution,
      institutionSlug: accounts.institutionSlug,
      currency: accounts.currency,
      type: accounts.type,
      balanceCents: accounts.balanceCents,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, session.id),
        eq(accounts.id, accountId),
        notDeleted(accounts.deletedAt),
      ),
    )
    .limit(1);
  if (!account) notFound();

  const flaggedRows = await db
    .select({
      id: transactions.id,
      occurredAt: transactions.occurredAt,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
      descriptionRaw: transactions.descriptionRaw,
      merchant: transactions.merchant,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, session.id),
        eq(transactions.accountId, accountId),
        eq(transactions.reconciliationStatus, "flagged"),
      ),
    )
    .orderBy(desc(transactions.occurredAt))
    .limit(200);

  const flagged: FlaggedRow[] = flaggedRows.map((r) => ({
    id: r.id,
    occurredAt: r.occurredAt.toISOString(),
    amountCents: r.amountCents.toString(),
    currency: r.currency,
    descriptionRaw: r.descriptionRaw,
    merchant: r.merchant,
  }));

  const mergeCandidateRows =
    flagged.length > 0
      ? await db
          .select({
            id: transactions.id,
            occurredAt: transactions.occurredAt,
            amountCents: transactions.amountCents,
            currency: transactions.currency,
            descriptionRaw: transactions.descriptionRaw,
          })
          .from(transactions)
          .where(
            and(
              eq(transactions.userId, session.id),
              eq(transactions.accountId, accountId),
              eq(transactions.reconciliationStatus, "imported_from_statement"),
            ),
          )
          .orderBy(desc(transactions.occurredAt))
          .limit(500)
      : [];

  const mergeCandidates: MergeCandidate[] = mergeCandidateRows.map((r) => ({
    id: r.id,
    occurredAt: r.occurredAt.toISOString(),
    amountCents: r.amountCents.toString(),
    currency: r.currency,
    descriptionRaw: r.descriptionRaw,
  }));

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-h1">Reconcile · {account.name}</h1>
          <p className="text-body text-muted-foreground">
            {account.institution} · {account.currency}. Upload the Bancolombia XLSX export for this
            account to reconcile against the bank statement.
          </p>
        </div>
        <Link
          href="/settings/accounts"
          className="text-muted-foreground text-sm underline-offset-2 hover:underline"
        >
          ← Accounts
        </Link>
      </header>

      {account.institutionSlug === "other" ? (
        <div className="rounded-md border border-amber-300 bg-amber-50/60 p-3 text-sm text-amber-900">
          This account&apos;s institution is tagged <code>other</code>. Reconciliation requires a
          known bank. Edit the account to set the correct institution before uploading a statement.
        </div>
      ) : (
        <ReconcileForm
          accountId={account.id}
          accountCurrency={account.currency}
          accountInstitutionSlug={account.institutionSlug}
          accountBalanceCents={account.balanceCents.toString()}
        />
      )}

      {flagged.length > 0 ? (
        <FlaggedReview
          rows={flagged}
          currency={account.currency}
          mergeCandidates={mergeCandidates}
        />
      ) : null}
    </main>
  );
}

export async function generateMetadata({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  return {
    title: `Reconcile account ${accountId} · Findash`,
  };
}
