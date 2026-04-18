import { sql } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import { classificationRuleSeeds, classificationRules } from "@/lib/db/schema";

/**
 * Copy every row from `classification_rule_seeds` into `classification_rules`
 * with the new user's id. Called once during signup, after the `users` row is
 * inserted.
 *
 * Idempotent: the unique index `(user_id, pattern, category_slug)` combined
 * with ON CONFLICT DO NOTHING makes this safe to re-run (e.g. if the signup
 * callback retries). Returns the number of rule rows materialized.
 */
export async function copyRuleSeedsToUser(
  userId: number,
  database: DB = defaultDb,
): Promise<number> {
  const result = await database.execute<{ id: number }>(sql`
    INSERT INTO classification_rules (user_id, pattern, category_slug, priority, active)
    SELECT ${userId}, pattern, category_slug, priority, true
    FROM ${classificationRuleSeeds}
    ON CONFLICT (user_id, pattern, category_slug) DO NOTHING
    RETURNING id
  `);
  return result.length;
}

// Re-export the table to keep the DI story obvious: callers pass a DB that
// exposes classificationRules; callers shouldn't need to know about seeds.
export { classificationRules };
