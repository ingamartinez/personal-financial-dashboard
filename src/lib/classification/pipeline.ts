import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db as defaultDb } from "@/lib/db";
import { categories, ingestionLogs, transactions, users } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { classifyBatchWithAi, type AiCategoryOption, type AiUserHint } from "./ai";
import { classifyByRule } from "./rules";

export const AI_BATCH_SIZE = 20;

export type PipelineResult = {
  picked: number;
  aiClassified: number;
  ruleClassified: number;
  skipped: number;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number };
  /** IDs of transactions that were successfully classified in this batch. */
  classifiedIds: number[];
};

export type ClassifyBatchOpts = {
  /** When provided, only classify these specific transaction IDs (still filtered by userId). */
  txIds?: number[];
};

/**
 * Retry safety: when the worker retries a job mid-batch (e.g. Anthropic
 * timeout after partial success), the WHERE clause below re-filters by
 * `classificationMethod = "unclassified"`. Rows already classified on the
 * previous attempt have a different method and are silently skipped, so
 * retries are idempotent in practice. The only theoretical race is two
 * retries firing within the DB-commit window of the first AI response —
 * BullMQ's exponential backoff (5s+) makes this effectively impossible.
 * If we ever observe duplicates, switch to a sentinel `"ai-pending"`
 * state set in a single UPDATE before the AI call.
 */
export async function classifyUnclassifiedBatch(
  userId: number,
  opts?: ClassifyBatchOpts,
): Promise<PipelineResult> {
  const db = defaultDb;
  const options: ClassifyBatchOpts = opts ?? {};

  const startedAt = new Date();

  const whereClause =
    options.txIds && options.txIds.length > 0
      ? and(
          eq(transactions.userId, userId),
          eq(transactions.classificationMethod, "unclassified"),
          isNull(transactions.categorySlug),
          notDeleted(transactions.deletedAt),
          inArray(transactions.id, options.txIds),
        )
      : and(
          eq(transactions.userId, userId),
          eq(transactions.classificationMethod, "unclassified"),
          isNull(transactions.categorySlug),
          notDeleted(transactions.deletedAt),
        );

  const pending = await db
    .select({
      id: transactions.id,
      description: transactions.descriptionRaw,
      merchant: transactions.merchant,
      descriptionClean: transactions.descriptionClean,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
    })
    .from(transactions)
    .where(whereClause)
    .orderBy(asc(transactions.id))
    .limit(AI_BATCH_SIZE);

  if (pending.length === 0) {
    return {
      picked: 0,
      aiClassified: 0,
      ruleClassified: 0,
      skipped: 0,
      model: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      classifiedIds: [],
    };
  }

  const [cats, userRow] = await Promise.all([
    db
      .select({
        slug: categories.slug,
        name: categories.name,
        parentSlug: categories.parentSlug,
      })
      .from(categories)
      .where(and(eq(categories.userId, userId), notDeleted(categories.deletedAt))),
    db
      .select({ context: users.classificationContext })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  ]);
  const catOptions: AiCategoryOption[] = cats;
  const userHints: AiUserHint[] = userRow[0]?.context?.merchant_hints ?? [];

  let ruleClassified = 0;
  const classifiedIds: number[] = [];
  const stillPending: typeof pending = [];
  for (const tx of pending) {
    const ruleHit = await classifyByRule(
      userId,
      {
        descriptionRaw: tx.description,
        descriptionClean: tx.descriptionClean,
        merchant: tx.merchant,
      },
      db,
    );
    if (ruleHit) {
      await db
        .update(transactions)
        .set({
          categorySlug: ruleHit.categorySlug,
          classificationMethod: "rule",
          classificationConfidence: ruleHit.confidence,
          updatedAt: new Date(),
        })
        .where(and(eq(transactions.userId, userId), eq(transactions.id, tx.id)));
      ruleClassified++;
      classifiedIds.push(tx.id);
    } else {
      stillPending.push(tx);
    }
  }

  if (stillPending.length === 0) {
    return {
      picked: pending.length,
      aiClassified: 0,
      ruleClassified,
      skipped: 0,
      model: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      classifiedIds,
    };
  }

  const aiResult = await classifyBatchWithAi({
    transactions: stillPending.map((t) => ({
      id: t.id,
      description: t.descriptionClean ?? t.merchant ?? t.description,
      amountCents: t.amountCents,
      currency: t.currency,
    })),
    categories: catOptions,
    userHints,
  });

  const byId = new Map(aiResult.classifications.map((c) => [c.id, c]));
  let aiClassified = 0;
  let skipped = 0;
  const ids = stillPending.map((t) => t.id);

  for (const tx of stillPending) {
    const hit = byId.get(tx.id);
    if (!hit || !hit.categorySlug) {
      skipped++;
      continue;
    }
    await db
      .update(transactions)
      .set({
        categorySlug: hit.categorySlug,
        classificationMethod: "ai",
        classificationConfidence: hit.confidence,
        classificationReason: hit.reason?.slice(0, 200) ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.id, tx.id),
          inArray(transactions.id, ids),
        ),
      );
    aiClassified++;
    classifiedIds.push(tx.id);
  }

  await db.insert(ingestionLogs).values({
    userId,
    source: "manual",
    status: skipped === 0 ? "ok" : "partial",
    itemsReceived: pending.length,
    itemsInserted: aiClassified + ruleClassified,
    itemsDuplicated: 0,
    errorMessage: null,
    payload: {
      kind: "ai-classify",
      model: aiResult.model,
      usage: aiResult.usage,
      picked: pending.length,
      ruleClassified,
      aiClassified,
      skipped,
    },
    startedAt,
    finishedAt: new Date(),
  });

  return {
    picked: pending.length,
    aiClassified,
    ruleClassified,
    skipped,
    model: aiResult.model,
    usage: aiResult.usage,
    classifiedIds,
  };
}
