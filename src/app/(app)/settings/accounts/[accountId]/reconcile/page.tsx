import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, statementImports, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { derivedBalanceCentsSql } from "@/lib/accounts/queries";
import { formatAccountLabel } from "@/lib/accounts/format";
import { getSessionUser } from "@/lib/auth/session";
import { buttonVariants } from "@/components/ui/button";
// ReconcileForm kept wired for Phase 3 rollback safety — DO NOT delete until soak gate confirmed.
import { ReconcileForm } from "./reconcile-form";
import { FlaggedReview, type MergeCandidate } from "./flagged-review";
import { PlugCleanupSection, type Plug } from "./plug-cleanup";

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
      balanceCents: derivedBalanceCentsSql,
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
        notDeleted(transactions.deletedAt),
      ),
    )
    .orderBy(desc(transactions.occurredAt))
    .limit(200);

  const flagged = flaggedRows.map((r) => ({
    id: r.id,
    occurredAt: r.occurredAt.toISOString(),
    amountCents: r.amountCents.toString(),
    currency: r.currency,
    descriptionRaw: r.descriptionRaw,
    merchant: r.merchant,
  }));

  // Include `matched` candidates so a flagged row whose statement counterpart
  // was already consumed by a prior reconcile run still surfaces in the merge
  // picker (#544).
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
              inArray(transactions.reconciliationStatus, ["imported_from_statement", "matched"]),
              notDeleted(transactions.deletedAt),
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

  // For the suggestion engine (#544) we need every period that's been
  // reconciled for this account so we can decide whether a flagged row falls
  // inside any of them. A flagged row outside every period is recommended as
  // Keep (it's real, just missed by the statements you've uploaded so far).
  const accountPeriods =
    flagged.length > 0
      ? await db
          .select({
            periodStart: statementImports.periodStart,
            periodEnd: statementImports.periodEnd,
          })
          .from(statementImports)
          .where(
            and(eq(statementImports.userId, session.id), eq(statementImports.accountId, accountId)),
          )
      : [];

  const SIBLING_TOLERANCE_MS = 3 * 86_400_000;
  const periodBounds = accountPeriods.map((p) => ({
    start: new Date(p.periodStart).getTime(),
    // periodEnd is a date, expand to end-of-day so a tx at 23:59 of the last
    // day still counts as "inside the period".
    end: new Date(p.periodEnd).getTime() + 86_400_000 - 1,
  }));

  const enrichedFlagged = flagged.map((f) => {
    const fAmount = BigInt(f.amountCents);
    const fMs = new Date(f.occurredAt).getTime();
    const sibling = mergeCandidates.find((c) => {
      if (BigInt(c.amountCents) !== fAmount) return false;
      if (c.currency !== f.currency) return false;
      const cMs = new Date(c.occurredAt).getTime();
      return Math.abs(cMs - fMs) <= SIBLING_TOLERANCE_MS;
    });
    const inAnyPeriod = periodBounds.some((p) => fMs >= p.start && fMs <= p.end);
    let suggestedAction: "archive" | "keep" | null = null;
    if (sibling) suggestedAction = "archive";
    else if (!inAnyPeriod && periodBounds.length > 0) suggestedAction = "keep";
    return {
      ...f,
      suggestedSiblingId: sibling?.id ?? null,
      suggestedAction,
    };
  });

  // #434: load ALL balance_adjustment txs for this account (live + soft-deleted).
  // The cleanup UI filters client-side via a "Mostrar borrados" toggle so the
  // user can un-archive a row without a round-trip.
  const plugRows = await db
    .select({
      id: transactions.id,
      occurredAt: transactions.occurredAt,
      amountCents: transactions.amountCents,
      descriptionRaw: transactions.descriptionRaw,
      merchant: transactions.merchant,
      statementImportId: transactions.statementImportId,
      deletedAt: transactions.deletedAt,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, session.id),
        eq(transactions.accountId, accountId),
        eq(transactions.source, "balance_adjustment"),
      ),
    )
    .orderBy(desc(transactions.occurredAt));

  const plugs: Plug[] = plugRows.map((r) => ({
    id: r.id,
    occurredAtISO: r.occurredAt.toISOString(),
    amountCentsStr: r.amountCents.toString(),
    description: r.descriptionRaw || r.merchant || "Ajuste de saldo",
    statementImportId: r.statementImportId,
    deleted: r.deletedAt !== null,
  }));

  // Latest statement_imports.periodEnd drives the "probablemente obsoleto"
  // heuristic — a plug dated ≤ this value is likely compensating for data
  // that's now been imported.
  const [lastPeriodRow] = await db
    .select({ periodEnd: max(statementImports.periodEnd) })
    .from(statementImports)
    .where(
      and(
        eq(statementImports.userId, session.id),
        eq(statementImports.accountId, accountId),
        sql`${statementImports.cycle} IS NOT NULL`,
      ),
    );
  const lastStatementPeriodEndISO = lastPeriodRow?.periodEnd
    ? new Date(lastPeriodRow.periodEnd).toISOString()
    : null;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-h1">Reconcile · {formatAccountLabel(account)}</h1>
          <p className="text-body text-muted-foreground">
            {account.institution}. Upload the Bancolombia XLSX export for this account to reconcile
            against the bank statement.
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
        <div className="flex flex-col gap-3">
          {/* Phase 2: CTA deep-links to unified /imports page */}
          <Link
            href={`/imports?hint_account_id=${account.id}`}
            className={buttonVariants({ variant: "default" })}
          >
            Subir extracto →
          </Link>
          {/* ReconcileForm kept for Phase 3 rollback — hidden, not deleted */}
          <details className="text-muted-foreground text-xs">
            <summary className="cursor-pointer">Formulario legacy (reserva)</summary>
            <div className="mt-2">
              <ReconcileForm
                accountId={account.id}
                accountCurrency={account.currency}
                accountInstitutionSlug={account.institutionSlug}
                accountBalanceCents={account.balanceCents.toString()}
              />
            </div>
          </details>
        </div>
      )}

      {enrichedFlagged.length > 0 ? (
        <FlaggedReview
          rows={enrichedFlagged}
          currency={account.currency}
          mergeCandidates={mergeCandidates}
        />
      ) : null}

      {plugs.length > 0 ? (
        <PlugCleanupSection
          accountId={account.id}
          currentBalanceCentsStr={account.balanceCents.toString()}
          plugs={plugs}
          lastStatementPeriodEndISO={lastStatementPeriodEndISO}
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
