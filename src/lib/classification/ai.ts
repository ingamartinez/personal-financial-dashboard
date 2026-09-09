import { z } from "zod";
import type { Currency } from "@/lib/types";
import type { UserClassificationContextHint } from "@/lib/db/schema";
import { callClaude, DEFAULT_MODEL } from "@/lib/ai/anthropic-client";

export type AiClassifiable = {
  id: number;
  description: string;
  amountCents: bigint;
  currency: Currency;
};

export type AiCategoryOption = {
  slug: string;
  name: string;
  parentSlug?: string | null;
};

// #812: category slugs owned by another feature — never valid AI classification
// targets, no matter what the caller passes in `categories`. Two-layer defense,
// same pattern as the top-level-parent guard below: (1) excluded from the
// prompt entirely via buildSystemPrompt's input, so the model is never even
// offered it; (2) rejected again during sanitization, independent of whether
// it was offered — the prompt is never the only guard. Audited against
// src/lib/db/seed-reference-data.ts: "adjustments" is the only slug written
// exclusively by non-classification code (reconciliation balance-adjustment
// plugs — see ADJUSTMENT_CATEGORY_SLUG in settings/accounts/actions.ts and
// ADJUSTMENTS_CATEGORY_SLUG in bancolombia-statement/consolidate.ts).
export const SYSTEM_OWNED_CATEGORY_SLUGS: ReadonlySet<string> = new Set(["adjustments"]);

export type AiUserHint = UserClassificationContextHint;

// #809: when no existing category fits, the AI may propose a brand-new one
// instead of defaulting to "otros". `parentSlug: null` means a new top-level
// category; a non-null value MUST reference an existing TOP-LEVEL slug (not
// just any live slug) — enforced below in classifyBatchWithAi. The category
// schema only supports 2 levels (see the `categories_enforce_two_levels`
// Postgres trigger); nesting a new category under an existing subcategory
// would violate that trigger and abort the whole sweep run for a user. The
// caller (the weekly classify-sweep) decides whether a proposal actually gets
// auto-created — this module only sanitizes what the model returned. Sweep.ts
// re-validates independently against its own top-level set before ever
// inserting — this sanitization is defense-in-depth, not the only guard.
export type AiProposedCategory = {
  name: string;
  parentSlug: string | null;
};

export type AiClassification = {
  id: number;
  categorySlug: string | null;
  confidence: number;
  reason?: string;
  proposedCategory?: AiProposedCategory | null;
};

export type AiClassifyResult = {
  classifications: AiClassification[];
  model: string;
  usage: { inputTokens: number; outputTokens: number };
};

const responseSchema = z.object({
  classifications: z.array(
    z.object({
      id: z.number().int(),
      categorySlug: z.string().min(1).max(60).nullable(),
      confidence: z.number().int().min(0).max(100),
      reason: z.string().max(200).optional(),
      proposedCategory: z
        .object({
          name: z.string().min(1).max(80),
          parentSlug: z.string().min(1).max(60).nullable(),
        })
        .nullable()
        .optional(),
    }),
  ),
});

// User hints are the soft-signal half of the learning loop: past corrections
// this user has made on the same merchant. Hard signals (3+ same merchant →
// same category in 30d) become rule proposals via the cron, not hints. Deduped
// + truncated to the most recent LEARN_HINTS_IN_PROMPT per merchant for
// prompt-length hygiene — oldest wins on tie so a merchant that changed
// category shows both signals honestly.
const LEARN_HINTS_IN_PROMPT = 3;

function formatUserHints(hints: AiUserHint[]): string {
  if (hints.length === 0) return "";
  const byMerchant = new Map<string, AiUserHint[]>();
  for (const h of hints) {
    const key = h.merchant.toUpperCase();
    const bucket = byMerchant.get(key) ?? [];
    bucket.push(h);
    byMerchant.set(key, bucket);
  }
  const lines: string[] = [];
  for (const [merchant, bucket] of byMerchant) {
    const recent = bucket.slice(-LEARN_HINTS_IN_PROMPT);
    const cats = [...new Set(recent.map((h) => h.category))];
    lines.push(`- ${merchant} → ${cats.join(" / ")}`);
  }
  return lines.join("\n");
}

function buildSystemPrompt(cats: AiCategoryOption[]): string {
  const categoryList = cats
    .map((c) =>
      c.parentSlug
        ? `- ${c.slug} (${c.name}, subcategory of ${c.parentSlug})`
        : `- ${c.slug} (${c.name})`,
    )
    .join("\n");

  const topLevelList = cats
    .filter((c) => !c.parentSlug)
    .map((c) => `- ${c.slug} (${c.name})`)
    .join("\n");

  return `You classify personal finance transactions for a Colombian user.

Available categories (use the slug, exactly as written):
${categoryList}

For each transaction, pick the MOST specific category slug that fits. Prefer subcategories (e.g. "restaurantes" over "alimentacion").

If NO existing category is a good fit, but the transaction is a clearly recurring, specific type of merchant/expense that deserves its own home (e.g. a veterinary clinic, a barbershop), set "categorySlug" to null and instead fill "proposedCategory": { "name": "<short Spanish name>", "parentSlug": "<parentSlug>" }. The taxonomy only supports 2 levels, so "parentSlug" MUST be either null (a new top-level category) or exactly one of these TOP-LEVEL slugs — never a subcategory:
${topLevelList}

Do NOT propose a category for a one-off or ambiguous merchant — only for a specific, nameable kind of transaction.

"otros" is a LAST RESORT. Only use it when the transaction is genuinely unclassifiable AND no specific new category applies either — never as a default when you are simply unsure between two options (pick the closer one instead).

Confidence scale:
- 90-100: obvious match (e.g. "NETFLIX" → "suscripciones")
- 70-89: strong signal
- 50-69: educated guess
- 0-49: unsure — consider null

Rules:
- "categorySlug" MUST be one of the slugs above, or null (optionally with "proposedCategory" set) if truly unclassifiable.
- "proposedCategory.parentSlug" MUST be null or one of the top-level slugs listed above — never a subcategory slug.
- Include one entry per input transaction, same "id".
- Keep "reason" under 80 chars.`;
}

function buildUserPrompt(txs: AiClassifiable[], userHints: AiUserHint[]): string {
  const txList = txs
    .map(
      (t) =>
        `{ "id": ${t.id}, "description": ${JSON.stringify(t.description)}, "amount": ${(Number(t.amountCents) / 100).toFixed(2)}, "currency": "${t.currency}" }`,
    )
    .join(",\n  ");

  const hintsBlock = userHints.length
    ? `\n\nThis user has previously re-categorized these merchants. Treat as a STRONG preference signal for identical or similar merchant names, but categories above still constrain the final slug.\n${formatUserHints(userHints)}`
    : "";

  return `Transactions to classify:
[
  ${txList}
]${hintsBlock}`;
}

export type AiSingleClassifyResult = {
  classification: AiClassification | null;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
};

export async function classifySingleWithAi(opts: {
  transaction: AiClassifiable;
  categories: AiCategoryOption[];
  userHints?: AiUserHint[];
  model?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<AiSingleClassifyResult> {
  const batch = await classifyBatchWithAi({
    transactions: [opts.transaction],
    categories: opts.categories,
    userHints: opts.userHints,
    model: opts.model,
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
  });
  const hit = batch.classifications.find((c) => c.id === opts.transaction.id) ?? null;
  return { classification: hit, model: batch.model, usage: batch.usage };
}

export async function classifyBatchWithAi(opts: {
  transactions: AiClassifiable[];
  categories: AiCategoryOption[];
  userHints?: AiUserHint[];
  model?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<AiClassifyResult> {
  if (opts.transactions.length === 0) {
    return {
      classifications: [],
      model: opts.model ?? DEFAULT_MODEL,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  // #812 layer 1: system-owned categories are never offered to the model —
  // see SYSTEM_OWNED_CATEGORY_SLUGS above.
  const promptCategories = opts.categories.filter((c) => !SYSTEM_OWNED_CATEGORY_SLUGS.has(c.slug));

  // cache_control on the system prompt — the categoryList + instructions are
  // stable across every batch for this user. With output_config.format the
  // model can't hallucinate a shape, so the slug-validation below only needs
  // to reject slugs outside the user's current category set (edge case:
  // categories deleted between requests).
  const result = await callClaude({
    system: [{ text: buildSystemPrompt(promptCategories), cacheControl: true }],
    userPrompt: buildUserPrompt(opts.transactions, opts.userHints ?? []),
    schema: responseSchema,
    maxTokens: 2048,
    model: opts.model,
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
  });

  const validSlugs = new Set(opts.categories.map((c) => c.slug));
  // Only TOP-LEVEL slugs are valid parents for a proposed category — the
  // schema supports exactly 2 levels, and nesting under an existing
  // subcategory would violate the `categories_enforce_two_levels` Postgres
  // trigger. Intentionally stricter than `validSlugs` above.
  const topLevelSlugs = new Set(opts.categories.filter((c) => !c.parentSlug).map((c) => c.slug));
  const classifications = result.data.classifications.map((c) => ({
    ...c,
    // #812 layer 2: reject a system-owned slug even if it somehow made it
    // into `validSlugs` (e.g. a future caller forgets to keep its own
    // category list clean) — never let the prompt exclusion above be the
    // only guard.
    categorySlug:
      c.categorySlug &&
      validSlugs.has(c.categorySlug) &&
      !SYSTEM_OWNED_CATEGORY_SLUGS.has(c.categorySlug)
        ? c.categorySlug
        : null,
    // A proposedCategory naming a subcategory (or a slug that no longer
    // exists) as its parent is invalid — the model may have picked a
    // slightly-off parent, or ignored the top-level-only instruction. Rather
    // than dropping the whole proposal, null the parentSlug out — the
    // caller's fallback logic then correctly treats it as "no valid parent"
    // and settles the tx instead of attempting to create a category (the
    // sweep guardrail requires a real top-level parent to auto-create).
    // Same system-owned rejection applies here (#812): a proposal parented
    // under "adjustments" must fall back to "no valid parent", not create a
    // subcategory of the balance-adjustment bucket.
    proposedCategory: c.proposedCategory
      ? {
          name: c.proposedCategory.name,
          parentSlug:
            c.proposedCategory.parentSlug &&
            topLevelSlugs.has(c.proposedCategory.parentSlug) &&
            !SYSTEM_OWNED_CATEGORY_SLUGS.has(c.proposedCategory.parentSlug)
              ? c.proposedCategory.parentSlug
              : null,
        }
      : null,
  }));

  return {
    classifications,
    model: result.model,
    usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
  };
}
