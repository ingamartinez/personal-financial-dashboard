import { and, asc, count, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { AlertTriangleIcon, InboxIcon, ServerCrashIcon } from "lucide-react";
import { db } from "@/lib/db";
import { accounts, categories, ingestionLogs, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { formatAccountLabel } from "@/lib/accounts/format";
import { getSessionUser } from "@/lib/auth/session";
import { EmptyState } from "@/components/ui/empty-state";
import { CONFIDENCE_LOW_THRESHOLD } from "@/components/transactions/confidence-badge";
import { InboxTable, type InboxAccountOption, type InboxRow } from "./inbox-table";
import { ClassificationReviewList, type ReviewRow } from "./classification-review-list";
import { InboxPagination } from "./inbox-pagination";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

function parsePage(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "1", 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export default async function SettingsInboxPage({
  searchParams,
}: {
  searchParams: Promise<{ reviewsPage?: string; errorsPage?: string }>;
}) {
  const session = await getSessionUser();
  const params = await searchParams;

  const reviewsPage = parsePage(params.reviewsPage);
  const errorsPage = parsePage(params.errorsPage);
  const reviewsOffset = (reviewsPage - 1) * PAGE_SIZE;
  const errorsOffset = (errorsPage - 1) * PAGE_SIZE;

  // ─── WHERE clauses ──────────────────────────────────────────────────────────

  const reviewsWhere = and(
    eq(transactions.userId, session.id),
    inArray(transactions.classificationMethod, ["rule", "ai"]),
    gte(transactions.classificationConfidence, 0),
    lt(transactions.classificationConfidence, CONFIDENCE_LOW_THRESHOLD),
    notDeleted(transactions.deletedAt),
  );

  const errorsWhere = and(
    eq(ingestionLogs.userId, session.id),
    eq(ingestionLogs.status, "error"),
    isNull(ingestionLogs.resolvedAt),
  );

  // ─── All queries in one Promise.all ─────────────────────────────────────────

  const [reviewRows, [reviewCountRow], logRows, [errorCountRow], accountRows, categoryRows] =
    await Promise.all([
      // Classifications page
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
        .where(reviewsWhere)
        .orderBy(desc(transactions.occurredAt), desc(transactions.id))
        .limit(PAGE_SIZE)
        .offset(reviewsOffset),

      // Classifications total count
      db.select({ value: count() }).from(transactions).where(reviewsWhere),

      // Ingestion errors page
      db
        .select({
          id: ingestionLogs.id,
          source: ingestionLogs.source,
          errorMessage: ingestionLogs.errorMessage,
          payload: ingestionLogs.payload,
          startedAt: ingestionLogs.startedAt,
        })
        .from(ingestionLogs)
        .where(errorsWhere)
        .orderBy(desc(ingestionLogs.startedAt))
        .limit(PAGE_SIZE)
        .offset(errorsOffset),

      // Ingestion errors total count
      db.select({ value: count() }).from(ingestionLogs).where(errorsWhere),

      // Active accounts (for retry select)
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

      // Categories (for classification picker)
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

  // ─── Totals & page counts ────────────────────────────────────────────────────

  const reviewsTotal = reviewCountRow.value;
  const reviewsTotalPages = Math.max(1, Math.ceil(reviewsTotal / PAGE_SIZE));

  const errorsTotal = errorCountRow.value;
  const errorsTotalPages = Math.max(1, Math.ceil(errorsTotal / PAGE_SIZE));

  // ─── Shape data ──────────────────────────────────────────────────────────────

  const rows: InboxRow[] = logRows.map((r) => ({
    id: r.id,
    source: r.source,
    errorMessage: r.errorMessage,
    payload: r.payload,
    startedAt: r.startedAt.toISOString(),
  }));

  const accountOptions: InboxAccountOption[] = accountRows.map((a) => ({
    id: a.id,
    label: formatAccountLabel(a, { withInstitution: true }),
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

  const isEmpty = reviewsTotal === 0 && errorsTotal === 0;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
      {/* ── Page-level header ─────────────────────────────────────────────── */}
      <header>
        <h1 className="text-h1">Pendientes de revisar</h1>
        <p className="text-body text-muted-foreground">
          Acá se acumulan dos tipos de pendientes: clasificaciones automáticas con baja confianza y
          errores de ingesta. Trabajalas por sección.
        </p>
      </header>

      {/* ── Empty state ───────────────────────────────────────────────────── */}
      {isEmpty ? (
        <EmptyState
          icon={<InboxIcon />}
          title="Todo en orden"
          description="No hay errores de ingesta pendientes ni clasificaciones pendientes de revisar. Cuando llegue un SMS que no podamos rutear o una auto-clasificación con baja confianza, aparecerá acá."
        />
      ) : null}

      {/* ── Classifications section ───────────────────────────────────────── */}
      {reviewsTotal > 0 ? (
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <AlertTriangleIcon className="size-4 text-rose-600 dark:text-rose-400" />
              <h2 className="text-h2">Clasificaciones a revisar</h2>
            </div>
            <p className="text-body text-muted-foreground">
              Transacciones clasificadas con baja confianza. Confirmá la categoría sugerida,
              cambiala, o marcala como &ldquo;No me acuerdo&rdquo;.
            </p>
            <p className="text-muted-foreground text-xs">
              {reviewsPage === 1 && reviews.length < PAGE_SIZE
                ? `${reviewsTotal} clasificaci${reviewsTotal === 1 ? "ón" : "ones"}`
                : `${(reviewsPage - 1) * PAGE_SIZE + 1}–${(reviewsPage - 1) * PAGE_SIZE + reviews.length} de ${reviewsTotal} clasificaciones`}
            </p>
          </div>
          <ClassificationReviewList rows={reviews} categories={categoryRows} />
          <InboxPagination
            page={reviewsPage}
            totalPages={reviewsTotalPages}
            paramName="reviewsPage"
            otherParams={{ errorsPage }}
          />
        </section>
      ) : null}

      {/* ── Ingestion errors section ──────────────────────────────────────── */}
      {errorsTotal > 0 ? (
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <ServerCrashIcon className="size-4 text-amber-600 dark:text-amber-400" />
              <h2 className="text-h2">Errores de ingesta</h2>
            </div>
            <p className="text-body text-muted-foreground">
              SMS o ingests que fallaron y quedaron sin crear transacción. Reintentalos con la
              cuenta correcta o descartalos. El raw payload se conserva para auditoría aunque
              descartes.
            </p>
            <p className="text-muted-foreground text-xs">
              {errorsPage === 1 && rows.length < PAGE_SIZE
                ? `${errorsTotal} error${errorsTotal === 1 ? "" : "es"}`
                : `${(errorsPage - 1) * PAGE_SIZE + 1}–${(errorsPage - 1) * PAGE_SIZE + rows.length} de ${errorsTotal} errores`}
            </p>
          </div>
          <InboxTable rows={rows} accountOptions={accountOptions} />
          <InboxPagination
            page={errorsPage}
            totalPages={errorsTotalPages}
            paramName="errorsPage"
            otherParams={{ reviewsPage }}
          />
        </section>
      ) : null}
    </main>
  );
}
