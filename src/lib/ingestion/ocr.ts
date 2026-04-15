import { createHash } from "node:crypto";
import { z } from "zod";

export type OcrMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type OcrParsedRow = {
  rowIndex: number;
  occurredOn: string;
  description: string;
  amountCents: bigint;
  externalId: string;
};

export type OcrResult = {
  rows: OcrParsedRow[];
  skipped: { rowIndex: number; reason: string }[];
  model: string;
  usage: { inputTokens: number; outputTokens: number };
};

const responseSchema = z.object({
  transactions: z.array(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      description: z.string().min(1).max(500),
      amount: z.number().finite(),
    }),
  ),
});

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const PROMPT = `You extract transactions from a bank app screenshot.

Return ONLY valid JSON matching this shape (no prose, no markdown):
{
  "transactions": [
    { "date": "YYYY-MM-DD", "description": "string", "amount": number }
  ]
}

Rules:
- "amount" is a NUMBER in the account's currency (no symbols). Use NEGATIVE for debits/expenses/withdrawals and POSITIVE for credits/deposits/refunds.
- "date" in ISO YYYY-MM-DD. If the screenshot shows only day+month, use the most likely year from context; if ambiguous, use the current year.
- Keep "description" concise (merchant + reference when visible).
- Skip balance lines, totals, running balances, and UI chrome. Only real transactions.
- If the screenshot is unreadable or contains no transactions, return {"transactions": []}.`;

function toCents(amount: number): bigint {
  return BigInt(Math.round(amount * 100));
}

function buildExternalId(
  accountId: number,
  occurredOn: string,
  amountCents: bigint,
  description: string,
  positionInDay: number,
): string {
  const hash = createHash("sha256")
    .update(
      `${accountId}|${occurredOn}|${amountCents.toString()}|${description.trim()}|${positionInDay}`,
    )
    .digest("hex")
    .slice(0, 24);
  return `ocr:${accountId}:${hash}`;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  return JSON.parse(candidate);
}

export async function extractTransactionsFromImage(opts: {
  imageBase64: string;
  mediaType: OcrMediaType;
  accountId: number;
  model?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<OcrResult> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const model = opts.model ?? DEFAULT_MODEL;
  const doFetch = opts.fetchImpl ?? fetch;

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
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: opts.mediaType,
                data: opts.imageBase64,
              },
            },
            { type: "text", text: PROMPT },
          ],
        },
      ],
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

  const rows: OcrParsedRow[] = [];
  const skipped: { rowIndex: number; reason: string }[] = [];
  const dayCounters = new Map<string, number>();

  parsed.transactions.forEach((t, i) => {
    const description = t.description.trim();
    if (!description) {
      skipped.push({ rowIndex: i, reason: "Missing description" });
      return;
    }
    const amountCents = toCents(t.amount);
    if (amountCents === BigInt(0)) {
      skipped.push({ rowIndex: i, reason: "Zero amount" });
      return;
    }

    const dayKey = `${t.date}|${amountCents.toString()}|${description}`;
    const positionInDay = dayCounters.get(dayKey) ?? 0;
    dayCounters.set(dayKey, positionInDay + 1);

    rows.push({
      rowIndex: i,
      occurredOn: t.date,
      description,
      amountCents,
      externalId: buildExternalId(
        opts.accountId,
        t.date,
        amountCents,
        description,
        positionInDay,
      ),
    });
  });

  return {
    rows,
    skipped,
    model,
    usage: {
      inputTokens: payload.usage?.input_tokens ?? 0,
      outputTokens: payload.usage?.output_tokens ?? 0,
    },
  };
}
