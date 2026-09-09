// #814 Phase 5d: ILIKE pattern guard for AI-synthesized rule proposals.
//
// An AI-written pattern is dangerous in a way an exact merchant string is not.
// `%` matches every transaction; `%A%` nearly does. Validation is the door —
// insertSynthesizedRuleProposal re-runs it, so a branded cast cannot skip it,
// and the table CHECK rejects match-everything patterns even if a future
// caller writes SQL directly.
//
// Nothing here activates a classification_rules row. The AI proposes; the
// user decides.

import { and, desc, eq, sql } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import { categories, ruleProposals, transactions } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { isOpaqueMerchantKey } from "./merchant-knowledge";
import { matchOpaqueGateway } from "./opaque-gateways";

const SYSTEM_OWNED_CATEGORY_SLUGS: ReadonlySet<string> = new Set(["adjustments"]);

declare const validatedIlikePatternBrand: unique symbol;
export type ValidatedIlikePattern = string & {
  readonly [validatedIlikePatternBrand]: true;
};

export const SYNTHESIS_PATTERN_MIN_LITERALS = 3;
export const SYNTHESIS_PATTERN_MAX_LENGTH = 200;
export const SYNTHESIS_MAX_MATCH_SHARE = 0.1;
export const SYNTHESIS_MAX_MATCH_COUNT = 200;
export const SYNTHESIS_MIN_COVERED_MERCHANTS = 2;
export const PATTERN_BLAST_SAMPLE_SIZE = 5;

export class InvalidSynthesizedPatternError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "InvalidSynthesizedPatternError";
    this.code = code;
  }
}

export type PatternMatchSample = {
  id: number;
  merchant: string | null;
  descriptionClean: string | null;
};

export type PatternBlastRadius = {
  matchCount: number;
  totalCount: number;
  sample: PatternMatchSample[];
};

export type ValidateSynthesizedPatternInput = {
  userId: number;
  pattern: string;
  categorySlug: string;
  coveredMerchants: readonly string[];
};

export type ValidatedSynthesizedPattern = {
  readonly pattern: ValidatedIlikePattern;
  readonly matchCount: number;
  readonly matchSample: PatternMatchSample[];
};

export type InsertSynthesizedRuleProposalInput = {
  userId: number;
  categorySlug: string;
  pattern: ValidatedIlikePattern;
  coveredMerchants: readonly string[];
  correctionTxnIds: number[];
};

export type InsertSynthesizedRuleProposalResult =
  | {
      status: "inserted";
      id: number;
      userId: number;
      merchant: string;
      pattern: string;
      categorySlug: string;
    }
  | { status: "duplicate" };

export function ilikeLiteralLength(pattern: string): number {
  return pattern.replaceAll("%", "").replaceAll("_", "").length;
}

export function ilikeLiteralStem(pattern: string): string {
  return pattern.replaceAll("%", "").replaceAll("_", "").trim();
}

/**
 * Pure shape/specificity checks. No DB. `%` and `%A%` die here before any
 * history query. Opaque gateway stems are refused so a synthesized rule
 * cannot key on the bank/gateway string.
 */
export function assertIlikePatternShape(pattern: string): void {
  if (pattern.trim() !== pattern) {
    throw new InvalidSynthesizedPatternError(
      "trim",
      "synthesized ILIKE pattern must not have leading or trailing whitespace",
    );
  }
  if (pattern.length === 0 || pattern.length > SYNTHESIS_PATTERN_MAX_LENGTH) {
    throw new InvalidSynthesizedPatternError(
      "length",
      "synthesized ILIKE pattern must be 1–200 characters",
    );
  }
  if (ilikeLiteralLength(pattern) < SYNTHESIS_PATTERN_MIN_LITERALS) {
    throw new InvalidSynthesizedPatternError(
      "too_broad",
      "synthesized ILIKE pattern does not have enough literal characters",
    );
  }
  if (
    matchOpaqueGateway([pattern, ilikeLiteralStem(pattern)]) ||
    isOpaqueMerchantKey(ilikeLiteralStem(pattern))
  ) {
    throw new InvalidSynthesizedPatternError(
      "opaque_gateway",
      "synthesized ILIKE pattern must not key on an opaque payment gateway",
    );
  }
}

function patternMatchSql(pattern: string) {
  return sql`(
    ${transactions.descriptionClean} ILIKE ${pattern}
    OR ${transactions.merchant} ILIKE ${pattern}
    OR ${transactions.descriptionRaw} ILIKE ${pattern}
  )`;
}

/**
 * Full-history match including description_raw. Synthesis uses this to
 * reject an implausible share — a too-broad pattern that only hits SMS raw
 * is still dangerous on the live haystack. The proposal card does not use
 * this; it uses loadPatternApplyBlastRadius so the number equals apply.
 */
export async function loadPatternBlastRadius(
  userId: number,
  pattern: string,
  database: DB = defaultDb,
): Promise<PatternBlastRadius> {
  const [counts] = await database
    .select({
      matchCount: sql<number>`count(*) filter (where ${patternMatchSql(pattern)})::int`,
      totalCount: sql<number>`count(*)::int`,
    })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), notDeleted(transactions.deletedAt)));

  const sample = await database
    .select({
      id: transactions.id,
      merchant: transactions.merchant,
      descriptionClean: transactions.descriptionClean,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        notDeleted(transactions.deletedAt),
        patternMatchSql(pattern),
      ),
    )
    .orderBy(desc(transactions.occurredAt))
    .limit(PATTERN_BLAST_SAMPLE_SIZE);

  return {
    matchCount: counts?.matchCount ?? 0,
    totalCount: counts?.totalCount ?? 0,
    sample,
  };
}

function brandPattern(pattern: string): ValidatedIlikePattern {
  return pattern as ValidatedIlikePattern;
}

async function assertUsableCategorySlug(userId: number, slug: string, database: DB): Promise<void> {
  if (slug === "otros" || SYSTEM_OWNED_CATEGORY_SLUGS.has(slug)) {
    throw new InvalidSynthesizedPatternError(
      "category",
      "synthesized rule category slug is not a usable classification target",
    );
  }
  const [row] = await database
    .select({ slug: categories.slug })
    .from(categories)
    .where(
      and(
        eq(categories.userId, userId),
        eq(categories.slug, slug),
        notDeleted(categories.deletedAt),
      ),
    )
    .limit(1);
  if (!row) {
    throw new InvalidSynthesizedPatternError(
      "category",
      "synthesized rule category slug does not exist for this user",
    );
  }
}

/**
 * The only function that produces a ValidatedIlikePattern. A future caller
 * that passes a raw string into insert fails typecheck; a caller that casts
 * still dies here because insert re-invokes this.
 */
export async function validateSynthesizedPattern(
  input: ValidateSynthesizedPatternInput,
  database: DB = defaultDb,
): Promise<ValidatedSynthesizedPattern> {
  assertIlikePatternShape(input.pattern);
  await assertUsableCategorySlug(input.userId, input.categorySlug, database);

  const covered = [
    ...new Set(input.coveredMerchants.map((m) => m.trim()).filter((m) => m.length > 0)),
  ];
  if (covered.length < SYNTHESIS_MIN_COVERED_MERCHANTS) {
    throw new InvalidSynthesizedPatternError(
      "not_general",
      "synthesized ILIKE pattern must cover at least two distinct merchants",
    );
  }
  for (const merchant of covered) {
    if (isOpaqueMerchantKey(merchant) || matchOpaqueGateway([merchant])) {
      throw new InvalidSynthesizedPatternError(
        "opaque_gateway",
        "synthesized ILIKE pattern must not cover an opaque payment gateway",
      );
    }
    const [row] = await database.execute<{ ok: boolean }>(
      sql`SELECT ${merchant} ILIKE ${input.pattern} AS ok`,
    );
    if (!row?.ok) {
      throw new InvalidSynthesizedPatternError(
        "uncovered_merchant",
        "synthesized ILIKE pattern does not match a merchant it claims to cover",
      );
    }
  }

  const blast = await loadPatternBlastRadius(input.userId, input.pattern, database);
  if (blast.matchCount > SYNTHESIS_MAX_MATCH_COUNT) {
    throw new InvalidSynthesizedPatternError(
      "too_many_matches",
      "synthesized ILIKE pattern matches too many existing transactions",
    );
  }
  if (blast.totalCount > 0 && blast.matchCount / blast.totalCount > SYNTHESIS_MAX_MATCH_SHARE) {
    throw new InvalidSynthesizedPatternError(
      "match_share",
      "synthesized ILIKE pattern matches an implausible share of the user's history",
    );
  }

  return {
    pattern: brandPattern(input.pattern),
    matchCount: blast.matchCount,
    matchSample: blast.sample,
  };
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const message = err instanceof Error ? err.message : "";
  if (message.includes("rule_proposals_user_pattern_category_pending_unique")) return true;
  if (message.includes("rule_proposals_user_merchant_category_pending_unique")) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const code = (cause as { code?: unknown }).code;
    if (code === "23505") return true;
  }
  return false;
}

/**
 * Sole write path for a synthesized proposal. Re-validates so a
 * `as ValidatedIlikePattern` cast cannot store a dangerous pattern.
 * Writes rule_proposals only — never classification_rules.
 */
export async function insertSynthesizedRuleProposal(
  input: InsertSynthesizedRuleProposalInput,
  database: DB = defaultDb,
): Promise<InsertSynthesizedRuleProposalResult> {
  const validated = await validateSynthesizedPattern(
    {
      userId: input.userId,
      pattern: input.pattern,
      categorySlug: input.categorySlug,
      coveredMerchants: input.coveredMerchants,
    },
    database,
  );

  // Identity for this path is the pattern. Merchant is NOT NULL and shares a
  // pending unique with the correction cron — keying on a covered exact
  // merchant (UBER TRIP) lets that unique swallow the generalizing row.
  const merchant = validated.pattern.slice(0, 200);

  try {
    const [inserted] = await database
      .insert(ruleProposals)
      .values({
        userId: input.userId,
        merchant,
        pattern: validated.pattern,
        categorySlug: input.categorySlug,
        correctionTxnIds: input.correctionTxnIds,
        status: "pending",
        source: "synthesized",
      })
      .returning({
        id: ruleProposals.id,
        userId: ruleProposals.userId,
        merchant: ruleProposals.merchant,
        pattern: ruleProposals.pattern,
        categorySlug: ruleProposals.categorySlug,
      });

    return { status: "inserted", ...inserted };
  } catch (err) {
    if (isUniqueViolation(err)) return { status: "duplicate" };
    throw err;
  }
}
