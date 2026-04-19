import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { parserCanaryEvents, type CanaryProjection } from "@/lib/db/schema";
import { parseSmsBancolombia, type ParseResult } from "@/lib/ingestion/sms-bancolombia";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const SAMPLE_NUMERATOR = 1;
const SAMPLE_DENOMINATOR = 100;
const PROJECTION_FIELDS = ["amountCents", "currency", "merchant", "occurredOn"] as const;
type ProjectionField = (typeof PROJECTION_FIELDS)[number];

export function hashSmsBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

// Deterministic 1% sampling — derived from the sha256 of the body so the same
// SMS always gets the same verdict (reproducible in tests, replayable).
export function sampleForCanary(smsBody: string): boolean {
  const hash = hashSmsBody(smsBody);
  const bucket = parseInt(hash.slice(0, 8), 16) % SAMPLE_DENOMINATOR;
  return bucket < SAMPLE_NUMERATOR;
}

export function projectFromRegex(parsed: ParseResult): CanaryProjection {
  if (parsed.kind === "skip") {
    return { amountCents: null, currency: null, merchant: null, occurredOn: null };
  }
  return {
    amountCents: parsed.amountCents.toString(),
    currency: parsed.currency,
    merchant: merchantFromParsed(parsed),
    occurredOn: parsed.occurredOn,
  };
}

function merchantFromParsed(parsed: Exclude<ParseResult, { kind: "skip" }>): string | null {
  switch (parsed.kind) {
    case "purchase":
      return parsed.merchant;
    case "provider_payment":
    case "transfer_received":
    case "tc_credit_received":
      return parsed.senderName;
    case "provider_payment_sent":
      return parsed.providerName;
    case "bre_b_transfer":
      return parsed.recipientName;
    default:
      return null;
  }
}

export function compareProjections(
  regex: CanaryProjection,
  ai: CanaryProjection,
): { agreement: boolean; divergenceFields: ProjectionField[] } {
  const divergenceFields: ProjectionField[] = [];
  for (const field of PROJECTION_FIELDS) {
    if (!fieldsEqual(field, regex[field], ai[field])) divergenceFields.push(field);
  }
  return { agreement: divergenceFields.length === 0, divergenceFields };
}

function fieldsEqual(field: ProjectionField, a: string | null, b: string | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (field === "merchant") return normalizeMerchant(a) === normalizeMerchant(b);
  return a === b;
}

function normalizeMerchant(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const AI_PROMPT_HEADER = `You are parsing a single Bancolombia SMS notification. Extract these fields as strict JSON.

- amountCents: integer as string, amount × 100 (e.g. "$50,000 COP" → "5000000"). null if no amount.
- currency: "COP" | "USD" | null
- merchant: name of the other party — store name, person, provider. null if it's a transfer/withdrawal/ATM with no counterparty name.
- occurredOn: date as YYYY-MM-DD from the SMS (assume current year if only month/day shown). null if not present.

Return ONLY valid JSON with exactly these 4 keys. No prose.

SMS:
`;

export async function shadowParseSms(
  smsBody: string,
  opts?: { apiKey?: string; model?: string; fetchImpl?: typeof fetch },
): Promise<{
  projection: CanaryProjection;
  model: string;
  inputTokens: number;
  outputTokens: number;
}> {
  const apiKey = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const model = opts?.model ?? DEFAULT_MODEL;
  const doFetch = opts?.fetchImpl ?? fetch;

  const res = await doFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      messages: [{ role: "user", content: AI_PROMPT_HEADER + smsBody }],
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
  const text = payload.content?.find((c) => c.type === "text")?.text ?? "";
  return {
    projection: parseProjectionJson(text),
    model,
    inputTokens: payload.usage?.input_tokens ?? 0,
    outputTokens: payload.usage?.output_tokens ?? 0,
  };
}

export function parseProjectionJson(text: string): CanaryProjection {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("shadowParseSms: no JSON object in response");
  const raw = JSON.parse(match[0]) as Record<string, unknown>;
  return {
    amountCents: coerceStringOrNull(raw.amountCents),
    currency:
      raw.currency === "COP" || raw.currency === "USD" ? (raw.currency as "COP" | "USD") : null,
    merchant: coerceStringOrNull(raw.merchant),
    occurredOn: coerceStringOrNull(raw.occurredOn),
  };
}

function coerceStringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  return null;
}

// Entry point used by the SMS route's after() hook. Swallows errors — a
// canary failure must NEVER surface to the user or retry the ingestion.
export async function runCanaryForSms(params: {
  userId: number;
  body: string;
  sender: string | null;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  try {
    if (!sampleForCanary(params.body)) return;

    const regexParsed = parseSmsBancolombia(params.body);
    const regexProjection = projectFromRegex(regexParsed);
    const ai = await shadowParseSms(params.body, {
      apiKey: params.apiKey,
      fetchImpl: params.fetchImpl,
    });
    const { agreement, divergenceFields } = compareProjections(regexProjection, ai.projection);

    await db.insert(parserCanaryEvents).values({
      userId: params.userId,
      smsBodyHash: hashSmsBody(params.body),
      sender: params.sender,
      regexResult: regexProjection,
      aiResult: ai.projection,
      agreement,
      divergenceFields,
      aiModel: ai.model,
      aiInputTokens: ai.inputTokens,
      aiOutputTokens: ai.outputTokens,
    });
  } catch (err) {
    console.error("[canary] shadow parse failed", err);
  }
}
