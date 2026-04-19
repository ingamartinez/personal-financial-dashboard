import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import { categories, ingestionLogs, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { classifyBatchWithAi, type AiCategoryOption } from "./ai";
import { classifyByRule } from "./rules";

export const AI_BATCH_SIZE = 20;

export type PipelineResult = {
  picked: number;
  aiClassified: number;
  ruleClassified: number;
  skipped: number;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number };
};

export async function classifyUnclassifiedBatch(
  userId: number,
  database: DB = defaultDb,
): Promise<PipelineResult> {
  const startedAt = new Date();

  const pending = await database
    .select({
      id: transactions.id,
      description: transactions.descriptionRaw,
      merchant: transactions.merchant,
      descriptionClean: transactions.descriptionClean,
      amountCents: transactions.amountCents,
      currency: transactions.currency,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.classificationMethod, "unclassified"),
        isNull(transactions.categorySlug),
      ),
    )
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
    };
  }

  const cats = await database
    .select({
      slug: categories.slug,
      name: categories.name,
      parentSlug: categories.parentSlug,
    })
    .from(categories)
    .where(and(eq(categories.userId, userId), notDeleted(categories.deletedAt)));
  const catOptions: AiCategoryOption[] = cats;

  let ruleClassified = 0;
  const stillPending: typeof pending = [];
  for (const tx of pending) {
    const ruleHit = await classifyByRule(
      userId,
      {
        descriptionRaw: tx.description,
        descriptionClean: tx.descriptionClean,
        merchant: tx.merchant,
      },
      database,
    );
    if (ruleHit) {
      await database
        .update(transactions)
        .set({
          categorySlug: ruleHit.categorySlug,
          classificationMethod: "rule",
          classificationConfidence: ruleHit.confidence,
          updatedAt: new Date(),
        })
        .where(and(eq(transactions.userId, userId), eq(transactions.id, tx.id)));
      ruleClassified++;
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
    await database
      .update(transactions)
      .set({
        categorySlug: hit.categorySlug,
        classificationMethod: "ai",
        classificationConfidence: hit.confidence,
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
  }

  await database.insert(ingestionLogs).values({
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
  };
}
