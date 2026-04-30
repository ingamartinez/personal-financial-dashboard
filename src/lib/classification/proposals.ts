import { sql } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "classification/proposals" });

export type ProposalRow = {
  id: number;
  userId: number;
  merchant: string;
  categorySlug: string;
};

export type DetectProposalsResult = {
  scanned: number;
  inserted: number;
  skipped: number;
  proposals: ProposalRow[];
};

/**
 * Scan `classification_corrections` for (user, merchant, new_category) groups
 * with 3+ corrections in the last 30 days, insert a row into `rule_proposals`
 * with status='pending' for each group that isn't already pending or in 30d
 * denial cooldown.
 *
 * Run daily via `/api/cron/rule-proposals`. Idempotent — running twice on the
 * same data produces at most one pending proposal per group (enforced by the
 * partial unique index on status='pending').
 */
export async function detectAndEnqueueRuleProposals(
  database: DB = defaultDb,
): Promise<DetectProposalsResult> {
  const insertResult = await database.execute<{
    scanned: string;
    inserted_count: string;
    skipped: string;
    proposals: ProposalRow[] | null;
  }>(sql`
    WITH candidates AS (
      SELECT
        user_id,
        merchant,
        new_category_slug,
        jsonb_agg(transaction_id ORDER BY created_at) AS txn_ids,
        count(*) AS n
      FROM classification_corrections
      WHERE created_at > now() - interval '30 days'
        AND merchant IS NOT NULL
      GROUP BY user_id, merchant, new_category_slug
      HAVING count(*) >= 3
    ),
    insertable AS (
      SELECT c.*
      FROM candidates c
      WHERE NOT EXISTS (
        SELECT 1 FROM rule_proposals rp
        WHERE rp.user_id = c.user_id
          AND rp.merchant = c.merchant
          AND rp.category_slug = c.new_category_slug
          AND (
            rp.status = 'pending'
            OR (rp.status = 'denied' AND rp.decided_at > now() - interval '30 days')
          )
      )
    ),
    inserted AS (
      INSERT INTO rule_proposals (user_id, merchant, category_slug, correction_txn_ids, status)
      SELECT user_id, merchant, new_category_slug, txn_ids, 'pending'
      FROM insertable
      RETURNING id, user_id, merchant, category_slug
    )
    SELECT
      (SELECT count(*) FROM candidates)::text AS scanned,
      (SELECT count(*) FROM inserted)::text AS inserted_count,
      ((SELECT count(*) FROM candidates) - (SELECT count(*) FROM inserted))::text AS skipped,
      COALESCE(
        (SELECT jsonb_agg(jsonb_build_object(
          'id', id,
          'userId', user_id,
          'merchant', merchant,
          'categorySlug', category_slug
        )) FROM inserted),
        '[]'::jsonb
      ) AS proposals
  `);

  const row = insertResult[0] ?? { scanned: "0", inserted_count: "0", skipped: "0", proposals: [] };

  // postgres.js returns jsonb columns as already-parsed JS objects — no JSON.parse needed.
  const rawProposals = row.proposals ?? [];
  const proposals: ProposalRow[] = (Array.isArray(rawProposals) ? rawProposals : []).map((p) => ({
    id: Number(p.id),
    userId: Number(p.userId),
    merchant: p.merchant,
    categorySlug: p.categorySlug,
  }));

  const inserted = Number(row.inserted_count);

  if (proposals.length !== inserted) {
    log.error(
      {
        event: "rule_proposals_count_mismatch",
        inserted,
        proposalsLength: proposals.length,
      },
      "rule_proposals inserted count diverged from proposals array length — data may be incomplete",
    );
  }

  return {
    scanned: Number(row.scanned),
    inserted,
    skipped: Number(row.skipped),
    proposals,
  };
}
