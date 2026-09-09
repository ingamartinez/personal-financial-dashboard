// #814 Phase 5d: AI rule synthesis.
//
// Reads accumulated corrections and writes a generalizing ILIKE proposal.
// The correction cron already proposes exact merchant → category; this path
// exists only because a pattern can cover UBER TRIP, UBER EATS and
// UBER *TRIP HELP.UBER.COM at once.
//
// Model output is untrusted. Category slugs are constrained to ones that
// exist. The prompt is merchant names + slugs — never bank descriptions,
// amounts, dates, or accounts. callClaude has no tools. Persist the
// proposal; do not re-derive, and do not activate a rule.

import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { callClaude, HAIKU_MODEL, type CallClaudeOpts } from "@/lib/ai/anthropic-client";
import { db as defaultDb, type DB } from "@/lib/db";
import { categories, classificationRules, ruleProposals } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { createLogger } from "@/lib/logger";
import { isOpaqueMerchantKey } from "./merchant-knowledge";
import { matchOpaqueGateway } from "./opaque-gateways";
import {
  InvalidSynthesizedPatternError,
  SYNTHESIS_MAX_MATCH_COUNT,
  SYNTHESIS_MIN_COVERED_MERCHANTS,
  insertSynthesizedRuleProposal,
  type ValidatedIlikePattern,
} from "./pattern-validation";
import type { ProposalRow } from "./proposals";

const log = createLogger({ module: "classification/synthesize-rules" });

const SYSTEM_OWNED_CATEGORY_SLUGS: ReadonlySet<string> = new Set(["adjustments"]);

export const SYNTHESIS_CLUSTER_FIELDS = ["categorySlug", "merchants"] as const;
export const SYNTHESIS_MAX_TOKENS = 512;
export const SYNTHESIS_MAX_PROPOSALS_PER_USER = 5;
export const SYNTHESIS_MODEL = HAIKU_MODEL;

const TRANSACTION_SHAPED_FIELDS: ReadonlySet<string> = new Set([
  "amountCents",
  "amount_cents",
  "amount",
  "occurredAt",
  "occurred_at",
  "date",
  "accountId",
  "account_id",
  "account",
  "cardSuffix",
  "card_suffix",
  "last4",
  "last_4",
  "description",
  "descriptionRaw",
  "description_raw",
  "descriptionClean",
  "description_clean",
  "currency",
  "userId",
  "user_id",
  "userName",
  "user_name",
  "email",
  "address",
  "transaction",
  "tx",
  "transactions",
]);

export type SynthesisCluster = {
  categorySlug: string;
  merchants: readonly string[];
};

export type SynthesizeRuleProposalsResult = {
  usersScanned: number;
  inserted: number;
  skipped: number;
  proposals: ProposalRow[];
};

export type SynthesizeRulesForUserOpts = {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  database?: DB;
};

const synthesisSchema = z.object({
  rules: z
    .array(
      z.object({
        pattern: z.string().max(200),
        categorySlug: z.string().max(60),
        coveredMerchants: z.array(z.string().max(200)).min(SYNTHESIS_MIN_COVERED_MERCHANTS).max(20),
      }),
    )
    .max(SYNTHESIS_MAX_PROPOSALS_PER_USER),
});

type SynthesisModelOutput = z.infer<typeof synthesisSchema>;

/**
 * Whitelist pick. Merchant names + a category slug, nothing else. Extra keys
 * and transaction-shaped fields throw — redaction would hide the leak.
 */
export function pickSynthesisCluster(raw: unknown): SynthesisCluster {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("synthesis cluster must be an object with categorySlug and merchants");
  }
  const rec = raw as Record<string, unknown>;
  const allowed = new Set<string>(SYNTHESIS_CLUSTER_FIELDS);
  const extra = Object.keys(rec).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    const leaked = extra.filter((key) => TRANSACTION_SHAPED_FIELDS.has(key));
    if (leaked.length > 0) {
      throw new Error(
        `rule synthesis refuses transaction-shaped input (fields: ${leaked.sort().join(",")})`,
      );
    }
    throw new Error(
      `rule synthesis refuses extra input fields (fields: ${extra.sort().join(",")})`,
    );
  }
  const categorySlug = rec.categorySlug;
  const merchants = rec.merchants;
  if (typeof categorySlug !== "string" || categorySlug.trim() === "") {
    throw new Error("synthesis cluster requires a non-empty categorySlug");
  }
  if (!Array.isArray(merchants) || merchants.some((m) => typeof m !== "string")) {
    throw new Error("synthesis cluster merchants must be a string array");
  }
  return {
    categorySlug: categorySlug.trim(),
    merchants: merchants.map((m) => m.trim()).filter((m) => m.length > 0),
  };
}

export function buildSynthesisUserPrompt(clusters: readonly SynthesisCluster[]): string {
  const lines = clusters.map((cluster) => {
    const picked = pickSynthesisCluster(cluster);
    return `- ${picked.categorySlug}: ${picked.merchants.join(" | ")}`;
  });
  return `Merchant groups to generalize into ILIKE rules:\n${lines.join("\n")}`;
}

export function buildSynthesisSystemPrompt(opts: {
  categorySlugs: readonly string[];
  existingPatterns: readonly string[];
}): string {
  return [
    "You write PostgreSQL ILIKE patterns that generalize several merchant strings into one classification rule.",
    "A pattern must match at least two of the listed merchants. Do not wrap a single exact merchant — that path already exists.",
    "Use % as the wildcard. Prefer a distinctive token (%UBER%) over a short token (%U%).",
    "Do not write patterns for payment gateways (MercadoPago, Wompi, PayU, PASARELA) or bank descriptions.",
    `Category slug must be one of: ${opts.categorySlugs.join(", ")}. Never invent a slug or a category.`,
    opts.existingPatterns.length > 0
      ? `Existing rules — do not duplicate: ${opts.existingPatterns.join(", ")}`
      : "No existing rules.",
    `At most ${SYNTHESIS_MAX_PROPOSALS_PER_USER} rules. Skip a group if you cannot generalize it safely.`,
  ].join("\n");
}

type ClusterRow = {
  categorySlug: string;
  merchants: string[];
  txnIds: number[];
};

async function loadClusters(userId: number, database: DB): Promise<ClusterRow[]> {
  const rows = await database.execute<{
    category_slug: string;
    merchants: string[];
    txn_ids: number[] | null;
  }>(sql`
    SELECT
      new_category_slug AS category_slug,
      array_agg(DISTINCT merchant) AS merchants,
      jsonb_agg(transaction_id) AS txn_ids
    FROM classification_corrections
    WHERE user_id = ${userId}
      AND created_at > now() - interval '30 days'
      AND merchant IS NOT NULL
    GROUP BY new_category_slug
    HAVING count(DISTINCT merchant) >= ${SYNTHESIS_MIN_COVERED_MERCHANTS}
  `);

  const clusters: ClusterRow[] = [];
  for (const row of rows) {
    const merchants = (row.merchants ?? []).filter(
      (m) => m && !isOpaqueMerchantKey(m) && matchOpaqueGateway([m]) == null,
    );
    if (merchants.length < SYNTHESIS_MIN_COVERED_MERCHANTS) continue;
    if (row.category_slug === "otros" || SYSTEM_OWNED_CATEGORY_SLUGS.has(row.category_slug)) {
      continue;
    }
    clusters.push({
      categorySlug: row.category_slug,
      merchants,
      txnIds: Array.isArray(row.txn_ids) ? row.txn_ids.map(Number) : [],
    });
  }
  return clusters;
}

async function loadOfferedSlugs(userId: number, database: DB): Promise<string[]> {
  const rows = await database
    .select({ slug: categories.slug })
    .from(categories)
    .where(and(eq(categories.userId, userId), notDeleted(categories.deletedAt)));
  return rows
    .map((r) => r.slug)
    .filter((slug) => slug !== "otros" && !SYSTEM_OWNED_CATEGORY_SLUGS.has(slug));
}

async function loadExistingPatterns(userId: number, database: DB): Promise<string[]> {
  const rules = await database
    .select({ pattern: classificationRules.pattern })
    .from(classificationRules)
    .where(and(eq(classificationRules.userId, userId), eq(classificationRules.active, true)));
  const pending = await database
    .select({ pattern: ruleProposals.pattern })
    .from(ruleProposals)
    .where(and(eq(ruleProposals.userId, userId), eq(ruleProposals.status, "pending")));
  return [...rules.map((r) => r.pattern), ...pending.map((p) => p.pattern)];
}

async function deniedRecently(
  userId: number,
  pattern: string,
  categorySlug: string,
  database: DB,
): Promise<boolean> {
  const [row] = await database.execute<{ n: number }>(sql`
    SELECT 1 AS n
    FROM rule_proposals
    WHERE user_id = ${userId}
      AND pattern = ${pattern}
      AND category_slug = ${categorySlug}
      AND status = 'denied'
      AND decided_at > now() - interval '30 days'
    LIMIT 1
  `);
  return row != null;
}

/**
 * Type-level lock: this module calls callClaude, which must not grow a tools
 * parameter. The test assigns `HasTools = false` the same way PR2 did.
 */
export type SynthesisCallClaudeOpts = CallClaudeOpts<SynthesisModelOutput>;

export async function synthesizeRulesForUser(
  userId: number,
  opts: SynthesizeRulesForUserOpts = {},
): Promise<{ inserted: number; skipped: number; proposals: ProposalRow[] }> {
  const database = opts.database ?? defaultDb;
  const clusterRows = await loadClusters(userId, database);
  if (clusterRows.length === 0) {
    return { inserted: 0, skipped: 0, proposals: [] };
  }

  const offered = await loadOfferedSlugs(userId, database);
  const offeredSet = new Set(offered);
  const clusters = clusterRows
    .filter((row) => offeredSet.has(row.categorySlug))
    .map((row) =>
      pickSynthesisCluster({ categorySlug: row.categorySlug, merchants: row.merchants }),
    );
  if (clusters.length === 0) {
    return { inserted: 0, skipped: 0, proposals: [] };
  }

  const existingPatterns = await loadExistingPatterns(userId, database);
  const txnIdsBySlug = new Map(clusterRows.map((row) => [row.categorySlug, row.txnIds]));

  const { data } = await callClaude({
    feature: "rule-synthesis",
    model: SYNTHESIS_MODEL,
    maxTokens: SYNTHESIS_MAX_TOKENS,
    schema: synthesisSchema,
    system: buildSynthesisSystemPrompt({ categorySlugs: offered, existingPatterns }),
    userPrompt: buildSynthesisUserPrompt(clusters),
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
  });

  let inserted = 0;
  let skipped = 0;
  const proposals: ProposalRow[] = [];

  for (const rule of data.rules) {
    if (!offeredSet.has(rule.categorySlug)) {
      skipped++;
      log.info(
        { event: "rule_synthesis_slug_rejected", userId, categorySlug: rule.categorySlug },
        "synthesized slug is not in the user's categories",
      );
      continue;
    }
    if (existingPatterns.includes(rule.pattern)) {
      skipped++;
      continue;
    }
    if (await deniedRecently(userId, rule.pattern, rule.categorySlug, database)) {
      skipped++;
      continue;
    }

    try {
      const result = await insertSynthesizedRuleProposal(
        {
          userId,
          merchant: rule.coveredMerchants[0] ?? rule.pattern,
          categorySlug: rule.categorySlug,
          pattern: rule.pattern as ValidatedIlikePattern,
          coveredMerchants: rule.coveredMerchants,
          correctionTxnIds: txnIdsBySlug.get(rule.categorySlug) ?? [],
        },
        database,
      );
      if (result.status === "duplicate") {
        skipped++;
        continue;
      }
      inserted++;
      existingPatterns.push(result.pattern);
      proposals.push({
        id: result.id,
        userId: result.userId,
        merchant: result.merchant,
        pattern: result.pattern,
        categorySlug: result.categorySlug,
        source: "synthesized",
      });
    } catch (err) {
      skipped++;
      if (err instanceof InvalidSynthesizedPatternError) {
        log.info(
          {
            event: "rule_synthesis_rejected",
            userId,
            code: err.code,
            categorySlug: rule.categorySlug,
          },
          "synthesized pattern failed validation",
        );
        continue;
      }
      throw err;
    }
  }

  log.info(
    {
      event: "rule_synthesis_user_done",
      userId,
      inserted,
      skipped,
      matchCap: SYNTHESIS_MAX_MATCH_COUNT,
    },
    "rule synthesis for user complete",
  );

  return { inserted, skipped, proposals };
}

export async function synthesizeRuleProposals(
  opts: SynthesizeRulesForUserOpts = {},
): Promise<SynthesizeRuleProposalsResult> {
  const database = opts.database ?? defaultDb;
  const users = await database.execute<{ user_id: number }>(sql`
    SELECT DISTINCT user_id
    FROM classification_corrections
    WHERE created_at > now() - interval '30 days'
      AND merchant IS NOT NULL
  `);

  let inserted = 0;
  let skipped = 0;
  const proposals: ProposalRow[] = [];
  let usersScanned = 0;

  for (const row of users) {
    usersScanned++;
    try {
      const result = await synthesizeRulesForUser(row.user_id, { ...opts, database });
      inserted += result.inserted;
      skipped += result.skipped;
      proposals.push(...result.proposals);
    } catch (err) {
      log.error(
        { err, userId: row.user_id, event: "rule_synthesis_user_failed" },
        "rule synthesis failed for user — correction proposals still stand",
      );
    }
  }

  return { usersScanned, inserted, skipped, proposals };
}
