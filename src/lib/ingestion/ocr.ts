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
      // Optional echo of the literal sign token the model saw ("$" with no
      // minus = income, "-$" = expense). When present, this is the source of
      // truth for the sign; we only use the magnitude of `amount`. Dense
      // Colombian bank screenshots (Bancolombia movimientos) pack rows tightly
      // with both + and - rows, and vision models drop the minus or flip it
      // under token pressure. The echo forces the model to commit to what it
      // actually saw rather than inferring from description heuristics.
      sign_token: z.enum(["$", "-$"]).optional(),
    }),
  ),
});

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const PROMPT = `You extract transactions from a bank or fintech app screenshot.

Return ONLY valid JSON matching this shape (no prose, no markdown):
{
  "transactions": [
    { "date": "YYYY-MM-DD", "description": "string", "amount": number, "sign_token": "$" | "-$" }
  ]
}

The screenshot may be EITHER:
(a) a LIST of transactions (one row per tx), OR
(b) a DETAIL view of a SINGLE transaction (ARQ, Apple Wallet, etc.) — still return exactly one item.

Rules:
- "amount" is a JSON number (JSON uses "." as decimal separator). The screenshot may use "," as the decimal separator (e.g. Colombian/European locale): "25,54" = 25.54, NOT 2554. Thousands separators may be "." or "," — infer from context (two digits after the last separator = decimals).
- "sign_token" is THE SINGLE SOURCE OF TRUTH FOR DIRECTION. Look at the literal character(s) prefixing the amount in the screenshot and copy what you see:
  * "-$" → money leaving the account (expense, debit, payment, withdrawal, transfer sent)
  * "$" → money entering the account (income, credit, refund, transfer received)
  DO NOT infer sign from the description text. "TRANSFERENCIA" and "PAGO" can be EITHER direction depending on the sign token. A row labeled "TRANSFERENCIA" with "$ 101,00" (no minus) is INCOME; the same description with "-$ 100,00" is EXPENSE. The minus character is the only signal. Color (green = income, red = expense) is a confirmation cue but is NOT reliable under compression — always defer to the literal token.
- "amount" should match the sign_token: NEGATIVE when sign_token is "-$", POSITIVE when sign_token is "$". If sign_token and amount sign disagree, sign_token wins downstream — but you MUST set them consistent.
- Use the account's PRIMARY currency shown on the transaction (e.g. for ARQ use the USDc/USD amount, NOT the informational "Local amount" in COP). Treat USDc as USD.
- "date" in ISO YYYY-MM-DD. Parse dates like "13 Apr 2026" or "13 abr 2026" into "2026-04-13". Ignore the time of day. If only day+month are shown, use the most likely year from context; if truly ambiguous, use the current year.
- "description" = merchant name (+ short reference if visible). Prefer the merchant field (e.g. "PAYU*CINEMARK") over the app's category label (e.g. "Entertainment"). Keep it concise, no emojis, no card-mask strings like "··1356".
- Skip balance totals, running balances, rate/FX lines, card numbers, status badges, and UI chrome. Only real transactions.
- If unreadable or no transactions are visible, return {"transactions": []}.`;

function toCents(amount: number): bigint {
  return BigInt(Math.round(amount * 100));
}

/**
 * Resolves the signed cents amount using sign_token as source of truth.
 * - If sign_token is present, magnitude of `amount` is paired with the sign
 *   implied by the token ("-$" → negative, "$" → positive). Any disagreement
 *   between `amount`'s sign and `sign_token` is logged and the token wins.
 * - If sign_token is absent (older responses), fall back to the raw `amount`.
 */
function resolveSignedCents(
  amount: number,
  signToken: "$" | "-$" | undefined,
): { cents: bigint; mismatch: boolean } {
  if (!signToken) {
    return { cents: toCents(amount), mismatch: false };
  }
  const magnitude = toCents(Math.abs(amount));
  const expectedNegative = signToken === "-$";
  const actualNegative = amount < 0;
  const mismatch = expectedNegative !== actualNegative;
  const cents = expectedNegative ? -magnitude : magnitude;
  return { cents, mismatch };
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
    const { cents: amountCents, mismatch } = resolveSignedCents(t.amount, t.sign_token);
    if (amountCents === BigInt(0)) {
      skipped.push({ rowIndex: i, reason: "Zero amount" });
      return;
    }
    if (mismatch) {
      console.warn(
        `[ocr] row ${i} sign_token/amount mismatch — sign_token="${t.sign_token}" amount=${t.amount} → trusting sign_token`,
      );
    }

    const dayKey = `${t.date}|${amountCents.toString()}|${description}`;
    const positionInDay = dayCounters.get(dayKey) ?? 0;
    dayCounters.set(dayKey, positionInDay + 1);

    rows.push({
      rowIndex: i,
      occurredOn: t.date,
      description,
      amountCents,
      externalId: buildExternalId(opts.accountId, t.date, amountCents, description, positionInDay),
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
