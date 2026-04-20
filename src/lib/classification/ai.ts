import { z } from "zod";
import type { Currency } from "@/lib/types";
import type { UserClassificationContextHint } from "@/lib/db/schema";

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

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

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

function buildPrompt(
  txs: AiClassifiable[],
  cats: AiCategoryOption[],
  userHints: AiUserHint[],
): string {
  const categoryList = cats
    .map((c) =>
      c.parentSlug
        ? `- ${c.slug} (${c.name}, subcategory of ${c.parentSlug})`
        : `- ${c.slug} (${c.name})`,
    )
    .join("\n");

  const txList = txs
    .map(
      (t) =>
        `{ "id": ${t.id}, "description": ${JSON.stringify(t.description)}, "amount": ${(Number(t.amountCents) / 100).toFixed(2)}, "currency": "${t.currency}" }`,
    )
    .join(",\n  ");

  const hintsBlock = userHints.length
    ? `\n\nThis user has previously re-categorized these merchants. Treat as a STRONG preference signal for identical or similar merchant names, but categories above still constrain the final slug.\n${formatUserHints(userHints)}`
    : "";

  return `You classify personal finance transactions for a Colombian user.

Available categories (use the slug, exactly as written):
${categoryList}

Transactions to classify:
[
  ${txList}
]

For each transaction, pick the MOST specific category slug that fits. Prefer subcategories (e.g. "restaurantes" over "alimentacion"). If you genuinely cannot tell, return "otros".

Confidence scale:
- 90-100: obvious match (e.g. "NETFLIX" → "suscripciones")
- 70-89: strong signal
- 50-69: educated guess
- 0-49: unsure — consider "otros"

Return ONLY valid JSON (no prose, no markdown):
{
  "classifications": [
    { "id": <number>, "categorySlug": "<slug-or-null>", "confidence": <0-100>, "reason": "<short phrase>" }
  ]
}

Rules:
- "categorySlug" MUST be one of the slugs above, or null if truly unclassifiable.
- Include one entry per input transaction, same "id".
- Keep "reason" under 80 chars.${hintsBlock}`;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  return JSON.parse(candidate);
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

  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const model = opts.model ?? DEFAULT_MODEL;
  const doFetch = opts.fetchImpl ?? fetch;
  const prompt = buildPrompt(opts.transactions, opts.categories, opts.userHints ?? []);

  const res = await doFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const payload = (await res.json()) as {
    content: Array<{ type: string; text?: string }>;
    usage?: { input_tokens: number; output_tokens: number };
  };

  const textBlock = payload.content?.find((c) => c.type === "text")?.text ?? "";
  let parsedJson: unknown;
  try {
    parsedJson = extractJson(textBlock);
  } catch {
    throw new Error("Model returned invalid JSON");
  }

  const parsed = responseSchema.parse(parsedJson);
  const validSlugs = new Set(opts.categories.map((c) => c.slug));
  const classifications = parsed.classifications.map((c) => ({
    ...c,
    categorySlug: c.categorySlug && validSlugs.has(c.categorySlug) ? c.categorySlug : null,
  }));

  return {
    classifications,
    model,
    usage: {
      inputTokens: payload.usage?.input_tokens ?? 0,
      outputTokens: payload.usage?.output_tokens ?? 0,
    },
  };
}
