import { sql } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import {
  categories,
  categorySeeds,
  classificationRuleSeeds,
  classificationRules,
} from "@/lib/db/schema";

/**
 * Copy every row from `category_seeds` into `categories` with the new user's
 * id. Must run BEFORE `copyRuleSeedsToUser` — classification_rules FK is
 * composite against `(user_id, category_slug)` and would reject inserts until
 * the user has their own category rows.
 *
 * Idempotent: `(user_id, slug)` uniqueness + `ON CONFLICT DO NOTHING`.
 */
export async function copyCategorySeedsToUser(
  userId: number,
  database: DB = defaultDb,
): Promise<number> {
  const result = await database.execute<{ id: number }>(sql`
    INSERT INTO categories (user_id, slug, name, parent_slug, icon, color, sort_order)
    SELECT ${userId}, slug, name, parent_slug, icon, color, sort_order
    FROM ${categorySeeds}
    ON CONFLICT (user_id, slug) DO NOTHING
    RETURNING id
  `);
  return result.length;
}

/**
 * Copy every row from `classification_rule_seeds` into `classification_rules`
 * with the new user's id. Must run AFTER `copyCategorySeedsToUser` so the
 * composite FK to `categories(user_id, slug)` resolves.
 *
 * Idempotent: `(user_id, pattern, category_slug)` uniqueness + `ON CONFLICT
 * DO NOTHING` makes this safe to re-run (e.g. if the signup callback
 * retries). Returns the number of rule rows materialized.
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

// Re-export the tables to keep the DI story obvious.
export { categories, classificationRules };
