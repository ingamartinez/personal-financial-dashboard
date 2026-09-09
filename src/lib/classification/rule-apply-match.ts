// Shared predicate for retroactive rule apply, its preview, and the
// proposal-card blast count. A number computed with a different WHERE than
// the UPDATE invites a confident wrong approve.

import { desc, sql } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import { transactions } from "@/lib/db/schema";

export const RULE_APPLY_WINDOW_DAYS = 90;
export const RULE_APPLY_SAMPLE_SIZE = 5;

export type RuleApplyMatchSample = {
  id: number;
  merchant: string | null;
  descriptionClean: string | null;
};

export type RuleApplyBlastRadius = {
  matchCount: number;
  sample: RuleApplyMatchSample[];
};

/**
 * Last 90 days, description_clean OR merchant (not description_raw), already
 * classified, different category, not deleted. This is the set apply rewrites.
 */
export function ruleApplyMatchSql(userId: number, pattern: string, categorySlug: string) {
  return sql`(
    ${transactions.userId} = ${userId}
    AND ${transactions.occurredAt} > now() - interval '90 days'
    AND (
      ${transactions.descriptionClean} ILIKE ${pattern}
      OR ${transactions.merchant} ILIKE ${pattern}
    )
    AND ${transactions.categorySlug} IS NOT NULL
    AND ${transactions.categorySlug} <> ${categorySlug}
    AND ${transactions.deletedAt} IS NULL
  )`;
}

export async function loadPatternApplyBlastRadius(
  userId: number,
  pattern: string,
  categorySlug: string,
  database: DB = defaultDb,
): Promise<RuleApplyBlastRadius> {
  const [countRow] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(transactions)
    .where(ruleApplyMatchSql(userId, pattern, categorySlug));

  const sample = await database
    .select({
      id: transactions.id,
      merchant: transactions.merchant,
      descriptionClean: transactions.descriptionClean,
    })
    .from(transactions)
    .where(ruleApplyMatchSql(userId, pattern, categorySlug))
    .orderBy(desc(transactions.occurredAt))
    .limit(RULE_APPLY_SAMPLE_SIZE);

  return {
    matchCount: countRow?.n ?? 0,
    sample,
  };
}
