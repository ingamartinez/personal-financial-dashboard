import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { parserCanaryEvents, type CanaryProjection } from "@/lib/db/schema";
import { parseSmsBancolombia, type ParseResult } from "@/lib/ingestion/sms-bancolombia";
import { callClaude } from "@/lib/ai/anthropic-client";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "canary" });

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
  if (parsed.kind === "skip" || parsed.kind === "needs_review") {
    return { amountCents: null, currency: null, merchant: null, occurredOn: null };
  }
  return {
    amountCents: parsed.amountCents.toString(),
    currency: parsed.currency,
    merchant: merchantFromParsed(parsed),
    occurredOn: parsed.occurredOn,
  };
}

function merchantFromParsed(
  parsed: Exclude<ParseResult, { kind: "skip" | "needs_review" }>,
): string | null {
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

const AI_PROMPT_SYSTEM = `You are parsing a single Bancolombia SMS notification. Extract these fields as strict JSON.

- amountCents: integer as string, amount × 100 (e.g. "$50,000 COP" → "5000000"). null if no amount.
- currency: "COP" | "USD" | null
- merchant: name of the other party — store name, person, provider. null if it's a transfer/withdrawal/ATM with no counterparty name.
- occurredOn: date as YYYY-MM-DD from the SMS (assume current year if only month/day shown). null if not present.

Return ONLY valid JSON with exactly these 4 keys. No prose.`;

// Accept string or number for amountCents (model occasionally emits a raw int
// instead of stringified), normalize to string-or-null. Strings get trimmed;
// empty strings collapse to null.
const canaryProjectionSchema = z.object({
  amountCents: z
    .union([z.string(), z.number(), z.null()])
    .transform((v) => (v == null ? null : typeof v === "number" ? String(v) : v.trim() || null)),
  currency: z.enum(["COP", "USD"]).nullable(),
  merchant: z.union([z.string(), z.null()]).transform((v) => (v == null ? null : v.trim() || null)),
  occurredOn: z
    .union([z.string(), z.null()])
    .transform((v) => (v == null ? null : v.trim() || null)),
});

export async function shadowParseSms(
  smsBody: string,
  opts?: { apiKey?: string; model?: string; fetchImpl?: typeof fetch },
): Promise<{
  projection: CanaryProjection;
  model: string;
  inputTokens: number;
  outputTokens: number;
}> {
  const result = await callClaude({
    system: [{ text: AI_PROMPT_SYSTEM, cacheControl: true }],
    userPrompt: smsBody,
    schema: canaryProjectionSchema,
    maxTokens: 256,
    model: opts?.model,
    apiKey: opts?.apiKey,
    fetchImpl: opts?.fetchImpl,
  });

  return {
    projection: result.data,
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  };
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
    log.error({ err, event: "canary_shadow_parse_failed" }, "shadow parse failed");
  }
}
