import { and, eq } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import { db as defaultDb, type DB } from "@/lib/db";
import type * as schemaModule from "@/lib/db/schema";
import { transactions } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import { findMatchingRule, type ClassifiableTx } from "@/lib/classification/rules";

const log = createLogger({ module: "classification/reclassify" });

// Drizzle's top-level `db` and `tx` inside `db.transaction(...)` are nominally
// different types but structurally compatible for queries. Accept either so
// this function can be composed inside an existing transaction (atomicity with
// `applyEnrichment`) or called standalone. Pattern sourced from
// `src/lib/snapshots/payload.ts`.
export type ReclassifyDb =
  | DB
  | PgTransaction<
      PostgresJsQueryResultHKT,
      typeof schemaModule,
      ExtractTablesWithRelations<typeof schemaModule>
    >;

/**
 * Retroactive reclassification: re-runs the rule engine for a transaction
 * after enrichment (e.g. `enriched_merchant` set by Gmail matcher #454).
 *
 * Design decisions:
 * - Uses `findMatchingRule` (read-only), NOT `classifyByRule`. Bumping
 *   hit_count is a hot-path semantic that does not belong to retroactive runs.
 * - Does NOT touch `descriptionRaw` — that is the immutable audit field.
 * - Idempotent: calling twice with the same enriched_merchant produces
 *   identical DB state.
 * - Accepts an optional `database` param so callers can chain it inside an
 *   existing Drizzle transaction (atomicity with `applyEnrichment`).
 */
export async function reclassifyTransaction(
  userId: number,
  txId: number,
  database: ReclassifyDb = defaultDb,
): Promise<void> {
  // Load the transaction scoped by userId to prevent cross-tenant access.
  const [tx] = await database
    .select({
      id: transactions.id,
      userId: transactions.userId,
      enrichedMerchant: transactions.enrichedMerchant,
      descriptionClean: transactions.descriptionClean,
      merchant: transactions.merchant,
      descriptionRaw: transactions.descriptionRaw,
    })
    .from(transactions)
    .where(and(eq(transactions.id, txId), eq(transactions.userId, userId)));

  if (!tx) {
    log.warn(
      { userId, txId, event: "reclassify_tx_not_found" },
      "transaction not found for reclassify",
    );
    return;
  }

  // No-op if no enriched merchant — there is nothing extra for the rule
  // engine to match on beyond what the hot path already ran.
  if (!tx.enrichedMerchant) {
    log.debug(
      { userId, txId, event: "reclassify_no_enriched_merchant" },
      "no enriched_merchant; skipping reclassify",
    );
    return;
  }

  // Build a synthetic ClassifiableTx that prepends enriched_merchant so the
  // rule engine sees the real merchant name first in the ILIKE haystack.
  // We pack it into `descriptionClean` (slot 0 in txHaystack) because
  // txHaystack inside rules.ts is unexported — this is the surgical approach
  // to inject the enriched value without changing findMatchingRule's signature.
  const synthetic: ClassifiableTx = {
    // enriched_merchant at position 0 in the internal haystack
    descriptionClean: tx.enrichedMerchant,
    merchant: tx.merchant,
    descriptionRaw: tx.descriptionRaw,
  };

  // Cast to DB: findMatchingRule accepts DB (top-level drizzle) but we may
  // hold a PgTransaction (structurally compatible for all query ops, just
  // missing the `$client` field which findMatchingRule never uses).
  const rule = await findMatchingRule(userId, synthetic, database as DB);

  if (!rule) {
    log.info(
      { userId, txId, event: "reclassify_no_rule_match" },
      "no rule matched after enrichment; classification unchanged",
    );
    return;
  }

  await database
    .update(transactions)
    .set({
      categorySlug: rule.categorySlug,
      classificationMethod: "rule_retroactive",
      classificationConfidence: 100,
      classificationReason: `rule_retroactive: matched rule #${rule.id} via enriched_merchant`,
      updatedAt: new Date(),
    })
    .where(and(eq(transactions.id, txId), eq(transactions.userId, userId)));

  log.info(
    {
      userId,
      txId,
      ruleId: rule.id,
      categorySlug: rule.categorySlug,
      event: "reclassify_applied",
    },
    "reclassified transaction via enriched_merchant rule match",
  );
}
