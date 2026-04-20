import { and, asc, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { InboxIcon } from "lucide-react";
import { db } from "@/lib/db";
import { accounts, categories, ingestionLogs, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { getSessionUser } from "@/lib/auth/session";
import { EmptyState } from "@/components/ui/empty-state";
import { CONFIDENCE_LOW_THRESHOLD } from "@/components/transactions/confidence-badge";
import { InboxTable, type InboxAccountOption, type InboxRow } from "./inbox-table";
import { ClassificationReviewList, type ReviewRow } from "./classification-review-list";

export const dynamic = "force-dynamic";

export default async function SettingsInboxPage() {
  const session = await getSessionUser();

  const [logRows, accountRows, reviewRows, categoryRows] = await Promise.all([
    db
      .select({
        id: ingestionLogs.id,
        source: ingestionLogs.source,
        errorMessage: ingestionLogs.errorMessage,
        payload: ingestionLogs.payload,
        startedAt: ingestionLogs.startedAt,
      })
      .from(ingestionLogs)
      .where(
        and(
          eq(ingestionLogs.userId, session.id),
          eq(ingestionLogs.status, "error"),
          isNull(ingestionLogs.resolvedAt),
        ),
      )
      .orderBy(desc(ingestionLogs.startedAt))
      .limit(200),
    db
      .select({
        id: accounts.id,
        name: accounts.name,
        institution: accounts.institution,
        currency: accounts.currency,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, session.id),
          eq(accounts.active, true),
          notDeleted(accounts.deletedAt),
        ),
      )
      .orderBy(asc(accounts.institution), asc(accounts.name)),
    db
      .select({
        id: transactions.id,
        description: transactions.descriptionClean,
        descriptionRaw: transactions.descriptionRaw,
        merchant: transactions.merchant,
        amountCents: transactions.amountCents,
        currency: transactions.currency,
        categorySlug: transactions.categorySlug,
        confidence: transactions.classificationConfidence,
        method: transactions.classificationMethod,
        accountName: accounts.name,
        occurredAt: transactions.occurredAt,
      })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(
        and(
          eq(transactions.userId, session.id),
          inArray(transactions.classificationMethod, ["rule", "ai"]),
          gte(transactions.classificationConfidence, 0),
          lt(transactions.classificationConfidence, CONFIDENCE_LOW_THRESHOLD),
        ),
      )
      .orderBy(desc(transactions.occurredAt), desc(transactions.id))
      .limit(50),
    db
      .select({
        slug: categories.slug,
        name: categories.name,
        parentSlug: categories.parentSlug,
      })
      .from(categories)
      .where(and(eq(categories.userId, session.id), notDeleted(categories.deletedAt)))
      .orderBy(asc(categories.sortOrder), asc(categories.name)),
  ]);

  const rows: InboxRow[] = logRows.map((r) => ({
    id: r.id,
    source: r.source,
    errorMessage: r.errorMessage,
    payload: r.payload,
    startedAt: r.startedAt.toISOString(),
  }));

  const accountOptions: InboxAccountOption[] = accountRows.map((a) => ({
    id: a.id,
    label: `${a.institution} · ${a.name} (${a.currency})`,
    currency: a.currency,
  }));

  const categoryNameBySlug = new Map(categoryRows.map((c) => [c.slug, c.name]));
  const reviews: ReviewRow[] = reviewRows
    .filter(
      (r): r is typeof r & { categorySlug: string; confidence: number } =>
        r.categorySlug !== null && r.confidence !== null,
    )
    .filter((r) => r.method === "rule" || r.method === "ai")
    .map((r) => ({
      id: r.id,
      description: r.description ?? r.descriptionRaw,
      merchant: r.merchant,
      amountCents: r.amountCents.toString(),
      currency: r.currency,
      categorySlug: r.categorySlug,
      categoryName: categoryNameBySlug.get(r.categorySlug) ?? r.categorySlug,
      confidence: r.confidence,
      method: r.method as "rule" | "ai",
      accountName: r.accountName,
      occurredAt: r.occurredAt.toISOString(),
    }));

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header>
        <h1 className="text-h1">Ingestion inbox</h1>
        <p className="text-body text-muted-foreground">
          SMS o ingests que fallaron y quedaron sin crear transacción. Revisalos uno por uno:
          reintentalos con la cuenta correcta o descartalos. El raw payload se conserva para
          auditoría aunque descartes.
        </p>
      </header>
      {reviews.length > 0 ? (
        <ClassificationReviewList rows={reviews} categories={categoryRows} />
      ) : null}

      {rows.length === 0 && reviews.length === 0 ? (
        <EmptyState
          icon={<InboxIcon />}
          title="Todo en orden"
          description="No hay errores de ingesta pendientes ni clasificaciones pendientes de revisar. Cuando llegue un SMS que no podamos rutear o una auto-clasificación con baja confianza, aparecerá acá."
        />
      ) : null}

      {rows.length > 0 ? <InboxTable rows={rows} accountOptions={accountOptions} /> : null}
    </main>
  );
}
