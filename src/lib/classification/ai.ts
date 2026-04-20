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

export type AiUserHint = UserClassificationContextHint;

export type AiClassification = {
  id: number;
  categorySlug: string | null;
  confidence: number;
  reason?: string;
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

  return `You classify personal finance transactions for a Colombian user.

Available categories (use the slug, exactly as written):
${categoryList}

For each transaction, pick the MOST specific category slug that fits. Prefer subcategories (e.g. "restaurantes" over "alimentacion"). If you genuinely cannot tell, return null.

Confidence scale:
- 90-100: obvious match (e.g. "NETFLIX" → "suscripciones")
- 70-89: strong signal
- 50-69: educated guess
- 0-49: unsure — consider null

Rules:
- "categorySlug" MUST be one of the slugs above, or null if truly unclassifiable.
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

  // cache_control on the system prompt — the categoryList + instructions are
  // stable across every batch for this user. With output_config.format the
  // model can't hallucinate a shape, so the slug-validation below only needs
  // to reject slugs outside the user's current category set (edge case:
  // categories deleted between requests).
  const result = await callClaude({
    system: [{ text: buildSystemPrompt(opts.categories), cacheControl: true }],
    userPrompt: buildUserPrompt(opts.transactions, opts.userHints ?? []),
    schema: responseSchema,
    maxTokens: 2048,
    model: opts.model,
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
  });

  const validSlugs = new Set(opts.categories.map((c) => c.slug));
  const classifications = result.data.classifications.map((c) => ({
    ...c,
    categorySlug: c.categorySlug && validSlugs.has(c.categorySlug) ? c.categorySlug : null,
  }));

  return {
    classifications,
    model: result.model,
    usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
  };
}
