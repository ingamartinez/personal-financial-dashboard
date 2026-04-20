import { sql } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";

export type RuleMatch = {
  categorySlug: string;
  ruleId: number;
  confidence: 100;
};

export type ClassifiableTx = {
  descriptionRaw: string;
  descriptionClean?: string | null;
  merchant?: string | null;
};

function txHaystack(tx: ClassifiableTx): string {
  return [tx.descriptionClean, tx.merchant, tx.descriptionRaw]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ");
}

/**
 * Pure read-only rule lookup. Used by the classification-reason endpoint to
 * surface WHICH rule applies to a tx without any side effects (no hit_count
 * bump, no last_hit_at mutation). For the pipeline's ingest path, use
 * `classifyByRule` instead — it tracks usage as a side effect.
 */
export async function findMatchingRule(
  userId: number,
  tx: ClassifiableTx,
  database: DB = defaultDb,
): Promise<{ id: number; pattern: string; categorySlug: string } | null> {
  const haystack = txHaystack(tx);
  if (!haystack) return null;

  const matched = await database.execute<{ id: number; pattern: string; category_slug: string }>(
    sql`
      SELECT id, pattern, category_slug
      FROM classification_rules
      WHERE user_id = ${userId} AND active = true AND ${haystack} ILIKE pattern
      ORDER BY priority ASC, id ASC
      LIMIT 1
    `,
  );

  const row = matched[0];
  if (!row) return null;
  return { id: row.id, pattern: row.pattern, categorySlug: row.category_slug };
}

export async function classifyByRule(
  userId: number,
  tx: ClassifiableTx,
  database: DB = defaultDb,
): Promise<RuleMatch | null> {
  const haystack = txHaystack(tx);
  if (!haystack) return null;

  return database.transaction(async (trx) => {
    const matched = await trx.execute<{ id: number; category_slug: string }>(sql`
      SELECT id, category_slug
      FROM classification_rules
      WHERE user_id = ${userId} AND active = true AND ${haystack} ILIKE pattern
      ORDER BY priority ASC, id ASC
      LIMIT 1
    `);

    const row = matched[0];
    if (!row) return null;

    await trx.execute(sql`
      UPDATE classification_rules
      SET hit_count = hit_count + 1, last_hit_at = now()
      WHERE id = ${row.id} AND user_id = ${userId}
    `);

    return {
      categorySlug: row.category_slug,
      ruleId: row.id,
      confidence: 100,
    };
  });
}
