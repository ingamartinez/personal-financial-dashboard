// #809: classify-sweep — the only re-entry point for the `otros` bucket.
//
// `classifyUnclassifiedBatch` (pipeline.ts) only ever looks at
// `classification_method = 'unclassified'`, and the daily
// `classification-auto-uncategorize` job is a one-way door that dumps stale
// low-confidence rows INTO `otros`. Nothing ever revisited them, so `otros`
// only ever grew. This module is the weekly job that revisits it.
//
// Precedence per candidate transaction: ABSTAIN checks → PRIOR ART → rule
// engine → AI batch → settle.
//
// - Abstain (#812, evidence-aware in #814): before anything else, check
//   whether the row is structurally unclassifiable. Transfer-pair abstain
//   stays unconditional. Opaque-gateway abstain fires only when correlation
//   returns zero candidates — a unique receipt means the row is classifiable
//   from email. Confidence scores don't express "I have no business guessing
//   here": #809's own prod dry-run had the AI confidently (70-75) assigning
//   `tecnologia` to MercadoPago rows on reasoning like "user history shows
//   tech preference" — a guess that is WORSE than `otros` because the sweep's
//   own prior-art pass would then treat it as evidence and propagate it
//   forward. Abstained rows skip prior art, the rule engine, and the AI
//   entirely, and settle to `otros` with a distinct
//   `{"action":"abstained",...}` marker — visibly *awaiting enrichment*, not
//   *decided*. See `abstain`/`ABSTAINED_MARKER_ACTION`.
// - Prior art: does this SAME user already have a confident, real-category
//   decision for this SAME merchant elsewhere in their history? If so, reuse
//   it — see `fetchPriorArtIndex`/`resolvePriorArt` below. This runs BEFORE
//   the rule engine because a user's own explicit decision (especially a
//   manually-created category) must win over a generic seed rule that
//   happens to also match the description. #809's own review caught this:
//   the seed rule `%IMPTO GOBIERNO%` → `comisiones-bancarias` would otherwise
//   silently override a user who had already manually filed 3 occurrences of
//   that exact merchant under their own hand-made `4x100` category — exactly
//   the kind of manual work this issue exists to eliminate, not repeat.
// - Rule engine (free, deterministic, confidence 100) → AI batch (reuses
//   AI_BATCH_SIZE). The AI may either pick an existing category or propose a
//   brand-new one (see ai.ts). A proposal is only auto-created into a real
//   category when the SAME normalized name is proposed for
//   >= SWEEP_PROPOSAL_THRESHOLD transactions in this run AND it slots under
//   an existing parent — otherwise those transactions fall back to the
//   parent category itself.
// - Anything that still can't be resolved is "settled": `category_slug =
//   'otros'`, `classification_method = 'user_uncategorized'`,
//   `classification_reason` stamped with a `swept` marker.
//
// Why settle as `user_uncategorized` and not leave `method` as `rule`/`ai`:
// the daily auto-uncategorize job's WHERE clause only matches
// `method IN ('rule', 'ai')`. If a settled row kept `method = 'ai'` it would
// be re-swept, re-classified, and re-settled every week, with the daily job
// potentially reasserting `otros` in between — a slow-motion ping-pong the
// issue explicitly calls out. `user_uncategorized` is the system's existing
// "we tried, no signal, stop asking" terminal state, so reusing it here also
// takes the row out of the daily job's scope for free.
//
// Why classifications below SWEEP_MIN_CONFIDENCE are settled instead of
// applied: applying a low-confidence AI guess to a REAL category would put a
// `method='ai', confidence<60` row back in the daily auto-uncategorize job's
// crosshairs the moment it turns 30 days old (most `otros` stragglers already
// are) — undoing the sweep within 24h. Requiring >= SWEEP_MIN_CONFIDENCE
// before committing a category (existing or proposed) keeps every row the
// sweep resolves permanently outside that job's WHERE clause.
//
// The classification_reason "swept" marker is what makes a second consecutive
// run a no-op: a settled row is excluded from the very SELECT that feeds this
// job (see `candidateWhereClause`), regardless of its classification_method.

import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  max,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { db as defaultDb, type DB } from "@/lib/db";
import { categories, transactions, users } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { createLogger } from "@/lib/logger";
import { canonicalizeMerchant } from "@/lib/insights/merchant-canonical";
import type { ClassificationReasonJson } from "@/lib/db/schema";
import {
  classifyBatchWithAi,
  SYSTEM_OWNED_CATEGORY_SLUGS,
  type AiCategoryOption,
  type AiClassification,
  type AiUserHint,
} from "./ai";
import {
  citationFromEvidence,
  classifiableForRules,
  loadReceiptsById,
  loadTxEvidence,
  priorArtLookupRow,
  toAiClassifiable,
  type TxEvidence,
} from "./evidence";
import { matchOpaqueGateway } from "./opaque-gateways";
import {
  abstainReason,
  asReason,
  priorArtReason,
  receiptIdFromReason,
  sweptReason,
} from "./reason";
import { classifyByRule, findMatchingRule } from "./rules";

const log = createLogger({ module: "classification/sweep" });

export const SWEEP_BATCH_SIZE = 20;
export const SWEEP_MAX_BATCHES_PER_USER = 50;
export const SWEEP_PROPOSAL_THRESHOLD = 3;
export const SWEEP_MIN_CONFIDENCE = 60;
// Prior-art agreement threshold: a category needs >= this many agreeing
// historical rows for the same merchant to win UNLESS at least one of them
// is manual/manual_confirmed, in which case 1 is enough (manual outranks
// rule/ai — see resolvePriorArt).
export const PRIOR_ART_MIN_AGREEING_ROWS = 2;
const SWEPT_MARKER_ACTION = "swept";
// #812: distinct from SWEPT_MARKER_ACTION on purpose. "swept" means "we tried
// and this genuinely has no signal" — a deliberate terminal state. "abstained"
// means "we never even tried because the row is structurally opaque" (an
// unidentifiable gateway line, or one leg of a same-account transfer pair) —
// visibly *awaiting enrichment*, not *decided*. Both settle to
// category_slug='otros' so both are excluded from fetchPriorArtIndex's
// `category_slug NOT IN ('otros')` filter — an abstained row can never
// become prior-art evidence for a future run (see the module doc above).
const ABSTAINED_MARKER_ACTION = "abstained";

export type AbstainReason = "opaque_gateway" | "probable_transfer_pair";

export type SweepOpts = {
  /** Preview mode: compute every decision but never write to the DB. */
  dryRun?: boolean;
};

export type SweepChange = {
  txId: number;
  descriptionRaw: string;
  before: { categorySlug: string | null; classificationMethod: string };
  after: {
    categorySlug: string | null;
    classificationMethod: string;
    confidence: number;
    reason: ClassificationReasonJson | null;
  };
};

export type SweepCategoryCreated = {
  slug: string;
  name: string;
  parentSlug: string;
  supportingTxIds: number[];
  merchantExamples: string[];
};

export type SweepUserResult = {
  userId: number;
  picked: number;
  priorArtClassified: number;
  ruleClassified: number;
  aiClassified: number;
  settledToOtros: number;
  /** #812: rows abstained because the description names an opaque payment gateway. */
  abstainedGateway: number;
  /** #812: rows abstained because they look like an unpaired transfer leg. */
  abstainedTransferPair: number;
  categoriesCreated: SweepCategoryCreated[];
  model: string | null;
  changes: SweepChange[];
};

type CandidateTx = {
  id: number;
  accountId: number;
  occurredAt: Date;
  descriptionRaw: string;
  descriptionClean: string | null;
  merchant: string | null;
  canonicalMerchant: string | null;
  amountCents: bigint;
  currency: "COP" | "USD";
  categorySlug: string | null;
  classificationMethod: string;
  transferGroupId: string | null;
};

function sweptMarker(): ClassificationReasonJson {
  return sweptReason();
}

function abstainMarker(
  reason: AbstainReason,
  extra: Record<string, unknown> = {},
): ClassificationReasonJson {
  return abstainReason(reason, extra);
}

/**
 * Turn "Clínica Veterinaria Norte" into "clinica-veterinaria-norte". Mirrors
 * the client-side slugify in categories-manager.tsx — kept local here since
 * that one lives in a "use client" component and isn't exported.
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Merchant identity used to look up prior art. Reuses `canonicalizeMerchant`
 * (the same function `withCanonical`/the canonical_merchant backfill use at
 * ingest time) rather than inventing a new normalizer:
 *   1. `canonical_merchant` column, if already populated — it's already the
 *      canonical form.
 *   2. Else canonicalize the raw `merchant` field on the fly.
 *   3. Else canonicalize `description_raw` as a last resort (still strips
 *      gateway prefixes / internal-transfer skip patterns; imperfect for a
 *      full description but the best available signal when there's no
 *      merchant at all).
 * Lower-cased for case-insensitive matching — canonicalizeMerchant preserves
 * original casing. Returns null when there's nothing usable to key on (e.g.
 * descriptionRaw itself matches a skip pattern) — the caller falls through
 * to rule/AI in that case, same as "no prior art found".
 */
function merchantIdentityKey(row: {
  canonicalMerchant: string | null;
  merchant: string | null;
  descriptionRaw: string;
}): string | null {
  const key =
    row.canonicalMerchant ??
    canonicalizeMerchant(row.merchant) ??
    canonicalizeMerchant(row.descriptionRaw);
  return key ? key.toLowerCase() : null;
}

type PriorArtEvidence = { manualCount: number; totalCount: number };
type PriorArtIndex = Map<string, Map<string, PriorArtEvidence>>;

/**
 * Snapshot of this user's own prior, real-category decisions, indexed by
 * merchant identity. Fetched ONCE at the start of the run (not refreshed
 * mid-run) so results are order-independent within a single sweep — a
 * transaction the sweep itself classifies earlier in this same run does not
 * become "prior art" for a later transaction in the same run.
 *
 * Tenant-scoped by construction: the query is filtered on `userId` and
 * nothing here ever aggregates across users (see #336/#338 — cross-tenant
 * leaks from ungated joins/queries have burned this repo twice already).
 *
 * Only rows with a REAL category count as evidence: `category_slug NOT IN
 * ('otros')` AND `category_slug IS NOT NULL` AND not soft-deleted. Grouped
 * by (merchant identity, category_slug) counting total rows and how many of
 * those are manual/manual_confirmed — `resolvePriorArt` below turns this
 * into a single winning category or "ambiguous, fall through".
 *
 * #812: also excludes SYSTEM_OWNED_CATEGORY_SLUGS (e.g. "adjustments") —
 * a reconciliation balance-adjustment plug is not a classification decision
 * and must never become prior-art evidence for an unrelated merchant. This
 * is on top of (not instead of) ai.ts's own two-layer guard against the AI
 * ever targeting a system category directly.
 */
async function fetchPriorArtIndex(db: DB, userId: number): Promise<PriorArtIndex> {
  const rows = await db
    .select({
      categorySlug: transactions.categorySlug,
      classificationMethod: transactions.classificationMethod,
      canonicalMerchant: transactions.canonicalMerchant,
      merchant: transactions.merchant,
      descriptionRaw: transactions.descriptionRaw,
      classificationReason: transactions.classificationReason,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        notDeleted(transactions.deletedAt),
        ne(transactions.channel, "transfer"),
        notInArray(transactions.categorySlug, ["otros", ...SYSTEM_OWNED_CATEGORY_SLUGS]),
        isNotNull(transactions.categorySlug),
      ),
    );

  const opaqueReceiptIds: number[] = [];
  for (const row of rows) {
    if (!matchOpaqueGateway([row.descriptionRaw, row.merchant])) continue;
    const rid = receiptIdFromReason(asReason(row.classificationReason));
    if (rid != null) opaqueReceiptIds.push(rid);
  }
  const opaqueReceipts = await loadReceiptsById(userId, opaqueReceiptIds);

  const index: PriorArtIndex = new Map();
  for (const row of rows) {
    let key: string | null;
    if (matchOpaqueGateway([row.descriptionRaw, row.merchant])) {
      const rid = receiptIdFromReason(asReason(row.classificationReason));
      const receiptMerchant = rid != null ? (opaqueReceipts.get(rid)?.merchant ?? null) : null;
      key = receiptMerchant
        ? (canonicalizeMerchant(receiptMerchant)?.toLowerCase() ?? receiptMerchant.toLowerCase())
        : null;
    } else {
      key = merchantIdentityKey(row);
    }
    if (!key || !row.categorySlug) continue;

    const byCategory = index.get(key) ?? new Map<string, PriorArtEvidence>();
    const evidence = byCategory.get(row.categorySlug) ?? { manualCount: 0, totalCount: 0 };
    evidence.totalCount++;
    if (row.classificationMethod === "manual" || row.classificationMethod === "manual_confirmed") {
      evidence.manualCount++;
    }
    byCategory.set(row.categorySlug, evidence);
    index.set(key, byCategory);
  }
  return index;
}

/**
 * Resolve a single winning category from the evidence for one merchant
 * identity, or null when there's no signal or it's ambiguous.
 *
 * Ranking (manual outranks rule/ai, not just "counts more"):
 *   1. Exactly one category has >= 1 manual/manual_confirmed row → it wins
 *      outright, regardless of how many rows any other category has.
 *   2. Two or more categories each have manual/manual_confirmed evidence →
 *      ambiguous (the user contradicted themselves) → null.
 *   3. No manual evidence anywhere: exactly one category has
 *      >= PRIOR_ART_MIN_AGREEING_ROWS total rows → it wins.
 *   4. Otherwise (zero or multiple categories crossing that bar) → null.
 */
function resolvePriorArt(byCategory: Map<string, PriorArtEvidence> | undefined): string | null {
  if (!byCategory || byCategory.size === 0) return null;

  const manualWinners = [...byCategory.entries()].filter(([, e]) => e.manualCount >= 1);
  if (manualWinners.length === 1) return manualWinners[0]![0];
  if (manualWinners.length > 1) return null;

  const weakWinners = [...byCategory.entries()].filter(
    ([, e]) => e.totalCount >= PRIOR_ART_MIN_AGREEING_ROWS,
  );
  if (weakWinners.length === 1) return weakWinners[0]![0];
  return null;
}

function priorArtMarker(
  categorySlug: string,
  evidence: PriorArtEvidence,
): ClassificationReasonJson {
  return priorArtReason(categorySlug, evidence);
}

/**
 * Selection criteria (per user, tenant-scoped):
 *   - not soft-deleted
 *   - channel <> 'transfer' — transfer legs are null-category BY DESIGN;
 *     categorizing them double-counts spend (hard constraint, see #809).
 *   - classification_method NOT IN ('manual', 'manual_confirmed') — never
 *     touch a human decision.
 *   - (category_slug = 'otros') OR (category_slug IS NULL AND method IN
 *     ('unclassified', 'ai')) — the otros bucket, plus the AI's own "I don't
 *     know" null state (rule/manual nulls don't happen in practice, but the
 *     method filter keeps this scoped to what classifyUnclassifiedBatch would
 *     have produced).
 *   - not already settled OR abstained by a previous sweep run (the
 *     idempotency guard — see ABSTAINED_MARKER_ACTION above).
 *
 * `excludeIds` additionally drops transactions already pulled earlier in the
 * SAME run. This matters for two reasons: (1) in dry-run mode nothing is
 * actually written, so without it every batch would re-fetch the same rows
 * forever; (2) even in a real run, a transaction whose AI proposal is
 * deferred to the end-of-run proposal resolution (see `proposals` below)
 * keeps matching this WHERE clause until it's resolved — without the
 * exclusion it would be re-fetched and re-sent to the AI on every subsequent
 * batch until the run's proposal-resolution phase finally updates it.
 */
function candidateWhereClause(userId: number, excludeIds: number[]) {
  return and(
    eq(transactions.userId, userId),
    notDeleted(transactions.deletedAt),
    ne(transactions.channel, "transfer"),
    notInArray(transactions.classificationMethod, ["manual", "manual_confirmed"]),
    or(
      eq(transactions.categorySlug, "otros"),
      and(
        isNull(transactions.categorySlug),
        inArray(transactions.classificationMethod, ["unclassified", "ai"]),
      ),
    ),
    sql`(${transactions.classificationReason} IS NULL OR (
      ${transactions.classificationReason}->>'action' IS DISTINCT FROM ${SWEPT_MARKER_ACTION}
      AND ${transactions.classificationReason}->>'action' IS DISTINCT FROM ${ABSTAINED_MARKER_ACTION}
    ))`,
    excludeIds.length > 0 ? notInArray(transactions.id, excludeIds) : undefined,
  );
}

async function settle(
  db: DB,
  userId: number,
  tx: CandidateTx,
  changes: SweepChange[],
  dryRun: boolean,
): Promise<void> {
  const after = {
    categorySlug: "otros",
    classificationMethod: "user_uncategorized",
    confidence: 100,
    reason: sweptMarker(),
  };
  changes.push({
    txId: tx.id,
    descriptionRaw: tx.descriptionRaw,
    before: { categorySlug: tx.categorySlug, classificationMethod: tx.classificationMethod },
    after,
  });
  if (dryRun) return;
  await db
    .update(transactions)
    .set({
      categorySlug: after.categorySlug,
      classificationMethod: "user_uncategorized",
      classificationConfidence: after.confidence,
      classificationReason: after.reason,
      updatedAt: new Date(),
    })
    .where(and(eq(transactions.userId, userId), eq(transactions.id, tx.id)));
}

/**
 * Settle a row WITHOUT ever having attempted prior-art/rule/AI classification
 * — the row is structurally opaque (unidentifiable gateway line) or a
 * probable transfer leg, and a guess would be worse than no guess (#812).
 * Confidence is stamped 0 (as opposed to `settle`'s 100) precisely to signal
 * "no confidence was computed" vs. "we tried and genuinely can't tell".
 *
 * Same terminal shape as `settle` (category_slug='otros',
 * classification_method='user_uncategorized') so abstained rows are excluded
 * from the daily auto-uncategorize job's WHERE clause AND from
 * fetchPriorArtIndex's `category_slug NOT IN ('otros')` filter — an
 * abstained row can never resurface as prior-art evidence.
 */
async function abstain(
  db: DB,
  userId: number,
  tx: CandidateTx,
  reason: AbstainReason,
  extra: Record<string, unknown>,
  changes: SweepChange[],
  dryRun: boolean,
): Promise<void> {
  const after = {
    categorySlug: "otros",
    classificationMethod: "user_uncategorized",
    confidence: 0,
    reason: abstainMarker(reason, extra),
  };
  changes.push({
    txId: tx.id,
    descriptionRaw: tx.descriptionRaw,
    before: { categorySlug: tx.categorySlug, classificationMethod: tx.classificationMethod },
    after,
  });
  if (dryRun) return;
  await db
    .update(transactions)
    .set({
      categorySlug: after.categorySlug,
      classificationMethod: "user_uncategorized",
      classificationConfidence: after.confidence,
      classificationReason: after.reason,
      updatedAt: new Date(),
    })
    .where(and(eq(transactions.userId, userId), eq(transactions.id, tx.id)));
}

/**
 * Detect a probable unpaired transfer leg (#812): another LIVE row for the
 * SAME user, SAME account, SAME calendar date, exact opposite amount, same
 * currency, and not already grouped. This is deliberately narrower than
 * `src/lib/transfers/intra-user-pair.ts` (which requires a DIFFERENT
 * account — a normal cross-account self-transfer) — the rows this catches
 * are same-account loan refinance / term-extension legs (see #812's prod
 * evidence: tx 1728/1729, 1738/1739) that would otherwise wear
 * `channel='bank'` and get a spend category, double-counting the amount.
 *
 * Detection ONLY — this never writes `transfer_group_id` or flips `channel`.
 * Actually pairing the legs is transfer-pairing's own concern and belongs in
 * its own change (explicitly out of scope per #812).
 *
 * Tenant-safe: scoped on `userId` (memory: per-user-table-join-tenant-safety).
 */
async function findProbableTransferPair(
  db: DB,
  userId: number,
  tx: CandidateTx,
): Promise<number | null> {
  if (tx.transferGroupId !== null) return null;

  const [match] = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        notDeleted(transactions.deletedAt),
        ne(transactions.id, tx.id),
        eq(transactions.accountId, tx.accountId),
        eq(transactions.currency, tx.currency),
        eq(transactions.amountCents, -tx.amountCents),
        isNull(transactions.transferGroupId),
        sql`${transactions.occurredAt}::date = ${tx.occurredAt.toISOString()}::date`,
      ),
    )
    .limit(1);

  return match?.id ?? null;
}

async function applyCategory(
  db: DB,
  userId: number,
  tx: CandidateTx,
  categorySlug: string,
  method: "rule" | "ai" | "rule_retroactive",
  confidence: number,
  reason: ClassificationReasonJson | null,
  changes: SweepChange[],
  dryRun: boolean,
): Promise<void> {
  changes.push({
    txId: tx.id,
    descriptionRaw: tx.descriptionRaw,
    before: { categorySlug: tx.categorySlug, classificationMethod: tx.classificationMethod },
    after: { categorySlug, classificationMethod: method, confidence, reason },
  });
  if (dryRun) return;
  await db
    .update(transactions)
    .set({
      categorySlug,
      classificationMethod: method,
      classificationConfidence: confidence,
      classificationReason: reason,
      updatedAt: new Date(),
    })
    .where(and(eq(transactions.userId, userId), eq(transactions.id, tx.id)));
}

type ProposalBucket = {
  name: string;
  parentSlug: string;
  entries: { tx: CandidateTx; confidence: number; reason?: ClassificationReasonJson | null }[];
};

/**
 * Sweep the `otros` bucket for a single user. Exported separately from
 * `runClassifySweep` so the backfill script and tests can scope to one user.
 */
export async function sweepUserOtrosBucket(
  userId: number,
  opts: SweepOpts = {},
  database: DB = defaultDb,
): Promise<SweepUserResult> {
  const dryRun = opts.dryRun ?? false;
  const db = database;

  let picked = 0;
  let priorArtClassified = 0;
  let ruleClassified = 0;
  let aiClassified = 0;
  let settledToOtros = 0;
  let abstainedGateway = 0;
  let abstainedTransferPair = 0;
  let model: string | null = null;
  const changes: SweepChange[] = [];
  const categoriesCreated: SweepCategoryCreated[] = [];

  const cats = await db
    .select({ slug: categories.slug, name: categories.name, parentSlug: categories.parentSlug })
    .from(categories)
    .where(and(eq(categories.userId, userId), notDeleted(categories.deletedAt)));
  const catOptions: AiCategoryOption[] = cats;
  const existingSlugs = new Set(cats.map((c) => c.slug));
  // Only top-level categories are valid auto-create parents (or fallback
  // targets) — the schema supports exactly 2 levels. `existingSlugs` alone
  // is NOT enough here: it also contains subcategories, and nesting a new
  // category under an existing subcategory violates the
  // `categories_enforce_two_levels` Postgres trigger and would abort this
  // user's entire run. ai.ts already tries to keep the model from proposing
  // a subcategory parent, but that's a prompt-level nudge, not a guarantee —
  // this is the actual runtime guard.
  const topLevelSlugs = new Set(cats.filter((c) => !c.parentSlug).map((c) => c.slug));

  const [userRow] = await db
    .select({ context: users.classificationContext })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const userHints: AiUserHint[] = userRow?.context?.merchant_hints ?? [];

  const priorArtIndex = await fetchPriorArtIndex(db, userId);

  const proposals = new Map<string, ProposalBucket>();
  // Every transaction id pulled so far in this run, regardless of outcome —
  // see the doc comment on candidateWhereClause for why this exclusion is
  // required (not just a dry-run nicety).
  const seenIds: number[] = [];

  let iterations = 0;
  for (;;) {
    iterations++;
    if (iterations > SWEEP_MAX_BATCHES_PER_USER) {
      log.warn(
        { userId, iterations, event: "classify_sweep_max_batches_reached" },
        "classify-sweep: max batches reached for user — stopping early, remainder picked up next run",
      );
      break;
    }

    const batch: CandidateTx[] = await db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        occurredAt: transactions.occurredAt,
        descriptionRaw: transactions.descriptionRaw,
        descriptionClean: transactions.descriptionClean,
        merchant: transactions.merchant,
        canonicalMerchant: transactions.canonicalMerchant,
        amountCents: transactions.amountCents,
        currency: transactions.currency,
        categorySlug: transactions.categorySlug,
        classificationMethod: transactions.classificationMethod,
        transferGroupId: transactions.transferGroupId,
      })
      .from(transactions)
      .where(candidateWhereClause(userId, seenIds))
      .orderBy(asc(transactions.id))
      .limit(SWEEP_BATCH_SIZE);

    if (batch.length === 0) break;
    picked += batch.length;
    seenIds.push(...batch.map((t) => t.id));

    const stillPending: { tx: CandidateTx; evidence: TxEvidence }[] = [];
    for (const tx of batch) {
      // #812: abstain checks run BEFORE prior art. Transfer-pair stays
      // unconditional — one leg of an unpaired transfer must never get a
      // spend category. Opaque-gateway abstain is evidence-aware (#814):
      // only fire when correlation found nothing. A unique receipt means
      // the row is classifiable from email; an empty candidate set is the
      // original "structurally opaque" case.
      const transferPairTxId = await findProbableTransferPair(db, userId, tx);
      if (transferPairTxId) {
        await abstain(
          db,
          userId,
          tx,
          "probable_transfer_pair",
          { pairedTxId: transferPairTxId },
          changes,
          dryRun,
        );
        abstainedTransferPair++;
        log.info(
          {
            userId,
            txId: tx.id,
            pairedTxId: transferPairTxId,
            event: "classify_sweep_abstain_transfer_pair",
          },
          `classify-sweep: abstained tx ${tx.id} — probable unpaired transfer leg (partner ${transferPairTxId})`,
        );
        continue;
      }

      const evidence = await loadTxEvidence(userId, tx);
      const gatewayMatch = evidence.opaque;
      if (gatewayMatch && evidence.candidates.length === 0) {
        await abstain(db, userId, tx, "opaque_gateway", { gateway: gatewayMatch }, changes, dryRun);
        abstainedGateway++;
        if (gatewayMatch === "unknown_pasarela") {
          log.warn(
            {
              userId,
              txId: tx.id,
              descriptionRaw: tx.descriptionRaw,
              merchant: tx.merchant,
              event: "classify_sweep_abstain_unknown_pasarela",
            },
            `classify-sweep: abstained tx ${tx.id} — generic PASARELA gateway match, verify this isn't a real merchant`,
          );
        } else {
          log.info(
            { userId, txId: tx.id, gateway: gatewayMatch, event: "classify_sweep_abstain_gateway" },
            `classify-sweep: abstained tx ${tx.id} — opaque gateway (${gatewayMatch})`,
          );
        }
        continue;
      }

      // Prior art next — a user's own established decision for this exact
      // merchant outranks any seed rule (see the module doc comment and
      // resolvePriorArt for why). Opaque rows key on receipt.merchant, never
      // the bank gateway string (#814 prior-art poisoning).
      const identityKey = merchantIdentityKey(priorArtLookupRow(tx, evidence));
      const priorArtByCategory = identityKey ? priorArtIndex.get(identityKey) : undefined;
      const priorArtCategory = resolvePriorArt(priorArtByCategory);
      if (priorArtCategory && priorArtByCategory) {
        const priorEvidence = priorArtByCategory.get(priorArtCategory)!;
        await applyCategory(
          db,
          userId,
          tx,
          priorArtCategory,
          "rule_retroactive",
          priorEvidence.manualCount >= 1 ? 100 : 90,
          citationFromEvidence(evidence, priorArtMarker(priorArtCategory, priorEvidence)),
          changes,
          dryRun,
        );
        priorArtClassified++;
        continue;
      }

      const classifiable = classifiableForRules(tx, evidence);
      const ruleHit = dryRun
        ? await findMatchingRule(userId, classifiable, db).then((r) =>
            r ? { categorySlug: r.categorySlug, ruleId: r.id, confidence: 100 as const } : null,
          )
        : await classifyByRule(userId, classifiable, db);

      if (ruleHit) {
        await applyCategory(
          db,
          userId,
          tx,
          ruleHit.categorySlug,
          "rule",
          100,
          citationFromEvidence(evidence, { action: "rule", ruleId: ruleHit.ruleId }),
          changes,
          dryRun,
        );
        ruleClassified++;
      } else {
        stillPending.push({ tx, evidence });
      }
    }

    if (stillPending.length === 0) continue;

    const aiResult = await classifyBatchWithAi({
      transactions: stillPending.map(({ tx, evidence }) => toAiClassifiable(tx, evidence)),
      categories: catOptions,
      userHints,
    });
    model = aiResult.model;

    const byId = new Map<number, AiClassification>(aiResult.classifications.map((c) => [c.id, c]));

    for (const { tx, evidence } of stillPending) {
      const hit = byId.get(tx.id);
      const cited =
        hit?.reason || evidence.candidates.length > 0
          ? citationFromEvidence(evidence, hit?.reason ? { aiReason: hit.reason } : {})
          : null;

      if (
        hit?.categorySlug &&
        hit.categorySlug !== "otros" &&
        hit.confidence >= SWEEP_MIN_CONFIDENCE
      ) {
        await applyCategory(
          db,
          userId,
          tx,
          hit.categorySlug,
          "ai",
          hit.confidence,
          cited,
          changes,
          dryRun,
        );
        aiClassified++;
        continue;
      }

      if (hit?.proposedCategory && hit.confidence >= SWEEP_MIN_CONFIDENCE) {
        const normalized = slugify(hit.proposedCategory.name);
        if (normalized && hit.proposedCategory.parentSlug) {
          const bucket = proposals.get(normalized) ?? {
            name: hit.proposedCategory.name,
            parentSlug: hit.proposedCategory.parentSlug,
            entries: [],
          };
          bucket.entries.push({ tx, confidence: hit.confidence, reason: cited });
          proposals.set(normalized, bucket);
          continue;
        }
        // No valid parent (top-level proposals are never auto-created) —
        // nothing to fall back to either. Settle.
      }

      await settle(db, userId, tx, changes, dryRun);
      settledToOtros++;
    }
  }

  // Resolve proposals collected across the whole run for this user.
  for (const [slug, bucket] of proposals) {
    const meetsThreshold = bucket.entries.length >= SWEEP_PROPOSAL_THRESHOLD;
    const parentValid = topLevelSlugs.has(bucket.parentSlug);

    if (meetsThreshold && parentValid && !existingSlugs.has(slug)) {
      let created = false;
      if (!dryRun) {
        try {
          const [{ current } = { current: null }] = await db
            .select({ current: max(categories.sortOrder) })
            .from(categories)
            .where(
              and(
                eq(categories.userId, userId),
                eq(categories.parentSlug, bucket.parentSlug),
                notDeleted(categories.deletedAt),
              ),
            );
          const inserted = await db
            .insert(categories)
            .values({
              userId,
              slug,
              name: bucket.name,
              parentSlug: bucket.parentSlug,
              sortOrder: (current ?? 0) + 10,
            })
            .onConflictDoNothing({ target: [categories.userId, categories.slug] })
            .returning({ id: categories.id });
          created = inserted.length > 0;
        } catch (err) {
          // Defense-in-depth: `topLevelSlugs` proves `bucket.parentSlug` is
          // top-level for THIS user, but `categories_enforce_two_levels`'s
          // existence check has no user_id predicate — it queries across
          // ALL tenants. A slug that is top-level here can still be a CHILD
          // for a different user and trip the trigger. Never let that abort
          // the whole run: log and fall through to the existing
          // reuse/fallback/settle branches below, same as a lost race.
          created = false;
          log.warn(
            {
              err,
              userId,
              slug,
              parentSlug: bucket.parentSlug,
              event: "classify_sweep_category_create_failed",
            },
            `classify-sweep: category creation for "${slug}" failed — falling back to parent/settle`,
          );
        }
      } else {
        created = true; // preview: report what WOULD be created
      }

      if (created) {
        existingSlugs.add(slug);
        const merchantExamples = bucket.entries
          .slice(0, 5)
          .map((e) => e.tx.descriptionClean ?? e.tx.merchant ?? e.tx.descriptionRaw);
        categoriesCreated.push({
          slug,
          name: bucket.name,
          parentSlug: bucket.parentSlug,
          supportingTxIds: bucket.entries.map((e) => e.tx.id),
          merchantExamples,
        });
        log.info(
          {
            userId,
            slug,
            name: bucket.name,
            parentSlug: bucket.parentSlug,
            supportingTxCount: bucket.entries.length,
            merchantExamples,
            dryRun,
            event: "classify_sweep_category_created",
          },
          `classify-sweep: auto-created category "${slug}" from ${bucket.entries.length} recurring transactions`,
        );
        for (const entry of bucket.entries) {
          await applyCategory(
            db,
            userId,
            entry.tx,
            slug,
            "ai",
            entry.confidence,
            entry.reason ?? { aiReason: "ai_proposed_category" },
            changes,
            dryRun,
          );
          aiClassified++;
        }
        continue;
      }
      // Insert lost a race (slug now exists) — fall through to reuse it below
      // as if it were always a normal existing category.
    }

    if (existingSlugs.has(slug)) {
      // Either it already existed before this run, or a concurrent process
      // created it between our check and insert. Either way, it's a real,
      // valid category now — classify into it directly, no re-creation.
      for (const entry of bucket.entries) {
        await applyCategory(
          db,
          userId,
          entry.tx,
          slug,
          "ai",
          entry.confidence,
          entry.reason ?? null,
          changes,
          dryRun,
        );
        aiClassified++;
      }
      continue;
    }

    if (parentValid) {
      // Below threshold (or no valid parent for a would-be new slug that
      // collided) — fall back to the closest existing parent category.
      for (const entry of bucket.entries) {
        await applyCategory(
          db,
          userId,
          entry.tx,
          bucket.parentSlug,
          "ai",
          entry.confidence,
          entry.reason ?? null,
          changes,
          dryRun,
        );
        aiClassified++;
      }
      continue;
    }

    // No valid parent to fall back to either — settle.
    for (const entry of bucket.entries) {
      await settle(db, userId, entry.tx, changes, dryRun);
      settledToOtros++;
    }
  }

  return {
    userId,
    picked,
    priorArtClassified,
    ruleClassified,
    aiClassified,
    settledToOtros,
    abstainedGateway,
    abstainedTransferPair,
    categoriesCreated,
    model,
    changes,
  };
}

export type ClassifySweepResult = {
  usersProcessed: number;
  totalPicked: number;
  totalPriorArtClassified: number;
  totalRuleClassified: number;
  totalAiClassified: number;
  totalSettledToOtros: number;
  totalAbstainedGateway: number;
  totalAbstainedTransferPair: number;
  categoriesCreated: (SweepCategoryCreated & { userId: number })[];
  perUser: SweepUserResult[];
  /** userIds whose sweep threw and was skipped — see the per-user try/catch below. */
  failedUserIds: number[];
};

export type RunClassifySweepOpts = SweepOpts & {
  /** Scope to a single user (backfill script convenience). Default: all active users. */
  userId?: number;
  /** Scope to a specific set of users (test convenience). Takes precedence over `userId`. */
  userIds?: number[];
};

/**
 * Sweep the `otros` bucket for every active user. Entry point for both the
 * weekly BullMQ worker and the manual backfill script.
 */
export async function runClassifySweep(
  opts: RunClassifySweepOpts = {},
  database: DB = defaultDb,
): Promise<ClassifySweepResult> {
  const db = database;
  const scopeFilter =
    opts.userIds && opts.userIds.length > 0
      ? inArray(users.id, opts.userIds)
      : opts.userId !== undefined
        ? eq(users.id, opts.userId)
        : undefined;
  const activeUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.active, true), scopeFilter));

  const result: ClassifySweepResult = {
    usersProcessed: 0,
    totalPicked: 0,
    totalPriorArtClassified: 0,
    totalRuleClassified: 0,
    totalAiClassified: 0,
    totalSettledToOtros: 0,
    totalAbstainedGateway: 0,
    totalAbstainedTransferPair: 0,
    categoriesCreated: [],
    perUser: [],
    failedUserIds: [],
  };

  // One user's failure (a trigger violation the try/catch above didn't
  // anticipate, an Anthropic timeout, anything) must NOT abort every
  // remaining user — and a BullMQ retry of the whole job would just hit the
  // same data and fail identically for that one user again. Isolate per user.
  for (const u of activeUsers) {
    try {
      const userResult = await sweepUserOtrosBucket(u.id, { dryRun: opts.dryRun }, db);
      result.usersProcessed++;
      result.totalPicked += userResult.picked;
      result.totalPriorArtClassified += userResult.priorArtClassified;
      result.totalRuleClassified += userResult.ruleClassified;
      result.totalAiClassified += userResult.aiClassified;
      result.totalSettledToOtros += userResult.settledToOtros;
      result.totalAbstainedGateway += userResult.abstainedGateway;
      result.totalAbstainedTransferPair += userResult.abstainedTransferPair;
      result.categoriesCreated.push(
        ...userResult.categoriesCreated.map((c) => ({ ...c, userId: u.id })),
      );
      result.perUser.push(userResult);
    } catch (err) {
      result.failedUserIds.push(u.id);
      log.error(
        { err, userId: u.id, event: "classify_sweep_user_failed" },
        `classify-sweep: user ${u.id} failed — skipping, other users unaffected`,
      );
    }
  }

  return result;
}
