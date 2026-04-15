import { z } from "zod";

export type AiClassifiable = {
  id: number;
  description: string;
  amountCents: bigint;
  currency: "COP" | "USD";
};

export type AiCategoryOption = {
  slug: string;
  name: string;
  parentSlug?: string | null;
};

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

function buildPrompt(
  txs: AiClassifiable[],
  cats: AiCategoryOption[],
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
- Keep "reason" under 80 chars.`;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  return JSON.parse(candidate);
}

export async function classifyBatchWithAi(opts: {
  transactions: AiClassifiable[];
  categories: AiCategoryOption[];
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
  const prompt = buildPrompt(opts.transactions, opts.categories);

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
    categorySlug:
      c.categorySlug && validSlugs.has(c.categorySlug) ? c.categorySlug : null,
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
