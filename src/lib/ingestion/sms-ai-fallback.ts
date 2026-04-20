import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { callClaude } from "@/lib/ai/anthropic-client";
import { db } from "@/lib/db";
import { parserEvents, users } from "@/lib/db/schema";
import type { ParsedSms } from "./sms-bancolombia";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "sms-ai-fallback" });

// Hot-path budget: AI must return within 2s or the fallback is aborted and
// the SMS drops to the inbox. Keeps the user-perceived latency bounded even
// on the 5% needs_review path. Note this is wall-clock on the SDK call,
// not CPU time — network + prompt caching + inference all fit inside.
export const DEFAULT_TIMEOUT_MS = 2000;

// Auto-ingest threshold. Below this, the extraction is persisted as a
// low-confidence fallback and surfaces in /settings/inbox for user review
// rather than creating a transaction automatically.
export const MIN_CONFIDENCE = 0.8;

/**
 * Resolves whether AI fallback is enabled for this user.
 *
 * Priority:
 *   1. users.featureFlags.aiFallbackEnabled (per-user override) — wins if set
 *   2. process.env.AI_FALLBACK_ENABLED === "true" (global default)
 *
 * Defaults to OFF globally so enabling in prod is an explicit operator flip.
 */
export async function isAiFallbackEnabled(userId: number): Promise<boolean> {
  const rows = await db
    .select({ flags: users.featureFlags })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const perUser = rows[0]?.flags?.aiFallbackEnabled;
  if (perUser !== undefined) return perUser;
  return process.env.AI_FALLBACK_ENABLED === "true";
}

// MVP scope: the AI fallback only attempts the "purchase" kind today —
// format-drifted Bancolombia purchase SMS are the majority of needs_review
// cases. Transfers/QR/ATM stay in the inbox until we have enough
// observations to expand the schema. See #257 acceptance criteria.
const aiPurchaseSchema = z.object({
  kind: z.literal("purchase"),
  amountCents: z.string().regex(/^\d+$/),
  currency: z.enum(["COP", "USD"]),
  merchant: z.string().min(1),
  cardLast4: z.string().regex(/^\d{4}$/),
  cardKind: z.enum(["credit", "debit"]),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  occurredTime: z.string().regex(/^\d{2}:\d{2}$/),
  confidence: z.number().min(0).max(1),
});

type AiPurchase = z.infer<typeof aiPurchaseSchema>;

const AI_FALLBACK_SYSTEM = `You parse a Bancolombia SMS that the deterministic regex parser could not extract. Return a single JSON object with these fields, or set confidence below 0.8 if the SMS is not a purchase or you cannot extract all fields reliably.

- kind: always "purchase" (other SMS kinds are not supported in fallback yet — set low confidence for those).
- amountCents: integer as a string, amount × 100. "$50,000.00" → "5000000". "COP35.450,00" → "3545000". No decimals, no separators.
- currency: "COP" or "USD". If no explicit currency marker but amount format is Colombian ($ / COP), use "COP".
- merchant: the store / counterparty name. Trim whitespace. Preserve original case.
- cardLast4: 4 digits — the card *NNNN suffix. If missing, you cannot parse reliably → set confidence low.
- cardKind: "credit" for T.Cred, "debit" for T.Deb. Default "credit" if ambiguous.
- occurredOn: YYYY-MM-DD. Convert DD/MM/YYYY inputs; assume current year if only DD/MM.
- occurredTime: HH:MM (24h). Drop any seconds.
- confidence: 0..1. Use the scale below.

Confidence scale:
- 0.95-1.00: every field matches the format guide with zero ambiguity.
- 0.85-0.94: minor reformatting but every field is extractable.
- 0.80-0.84: one field required a judgment call (date assumed current year, cardKind defaulted).
- 0.60-0.79: the SMS is a purchase but a field is missing or suspicious. Will surface to the user's inbox.
- 0.00-0.59: not a purchase, or unparseable — auto-surface to inbox.

Few-shot examples:

Input: "Bancolombia: Compraste $45.000,00 en RAPPI con tu T.Cred *2575, el 15/04/2026 a las 19:30"
Output: {"kind":"purchase","amountCents":"4500000","currency":"COP","merchant":"RAPPI","cardLast4":"2575","cardKind":"credit","occurredOn":"2026-04-15","occurredTime":"19:30","confidence":0.97}

Input: "Bancolombia: Pago de USD12,50 en NETFLIX.COM desde T.Deb *7073 el 2026/04/10 08:00"
Output: {"kind":"purchase","amountCents":"1250","currency":"USD","merchant":"NETFLIX.COM","cardLast4":"7073","cardKind":"debit","occurredOn":"2026-04-10","occurredTime":"08:00","confidence":0.88}

Input: "Bancolombia: Transferiste $50.000 a la cuenta *1234 el 14/04/2026"
Output: {"kind":"purchase","amountCents":"0","currency":"COP","merchant":"","cardLast4":"0000","cardKind":"credit","occurredOn":"2026-04-14","occurredTime":"00:00","confidence":0.10}`;

export type AiFallbackOutcome =
  | {
      status: "success";
      parsed: ParsedSms;
      confidence: number;
      ai: { model: string; tokensIn: number; tokensOut: number };
    }
  | {
      status: "low_confidence";
      confidence: number;
      rawAi: AiPurchase;
      ai: { model: string; tokensIn: number; tokensOut: number };
    }
  | {
      status: "error";
      reason: "timeout" | "api_error" | "schema_rejected" | "disabled";
      detail?: string;
    };

/**
 * Calls Haiku to extract a purchase from an SMS the regex parser couldn't
 * match. Returns a status union — callers persist both the transaction
 * (success) and the telemetry row (all outcomes) so dashboards can measure
 * fallback win rate and cost.
 */
export async function aiFallbackParseSms(
  smsBody: string,
  opts?: { apiKey?: string; timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<AiFallbackOutcome> {
  try {
    const result = await callClaude({
      system: [{ text: AI_FALLBACK_SYSTEM, cacheControl: true }],
      userPrompt: smsBody,
      schema: aiPurchaseSchema,
      maxTokens: 512,
      timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      apiKey: opts?.apiKey,
      fetchImpl: opts?.fetchImpl,
    });

    const ai = {
      model: result.model,
      tokensIn: result.usage.inputTokens,
      tokensOut: result.usage.outputTokens,
    };

    if (result.data.confidence < MIN_CONFIDENCE) {
      return {
        status: "low_confidence",
        confidence: result.data.confidence,
        rawAi: result.data,
        ai,
      };
    }

    const parsed = synthesizeParsedSms(result.data, smsBody);
    return { status: "success", parsed, confidence: result.data.confidence, ai };
  } catch (err) {
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      return { status: "error", reason: "timeout" };
    }
    if (err instanceof Anthropic.APIError) {
      return { status: "error", reason: "api_error", detail: `${err.status}: ${err.message}` };
    }
    if (err instanceof z.ZodError) {
      return { status: "error", reason: "schema_rejected", detail: err.message };
    }
    log.error({ err, event: "ai_fallback_unexpected_error" }, "unexpected error in AI fallback");
    return {
      status: "error",
      reason: "api_error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// Reconstruct a ParsedSms "purchase" variant from the AI's extraction +
// the original body. externalId derivation matches the regex parser so
// a retried-then-newly-regex'd SMS dedupes against the AI-ingested row.
function synthesizeParsedSms(ai: AiPurchase, rawBody: string): ParsedSms {
  const cents = BigInt(ai.amountCents);
  const payload = [
    "purchase",
    ai.cardLast4,
    ai.currency,
    ai.occurredOn,
    ai.occurredTime,
    cents.toString(),
    ai.merchant,
  ].join("|");
  const externalId = "bcol-sms:" + createHash("sha256").update(payload).digest("hex").slice(0, 24);

  return {
    kind: "purchase",
    amountCents: cents,
    currency: ai.currency,
    merchant: ai.merchant,
    cardLast4: ai.cardLast4,
    cardKind: ai.cardKind,
    occurredOn: ai.occurredOn,
    occurredTime: ai.occurredTime,
    externalId,
    raw: rawBody.trim(),
  };
}

/**
 * Persists a parser_events row describing the fallback outcome. Caller is
 * responsible for measuring `latencyMs`. This is write-only and non-blocking
 * from the caller's perspective — pipeline control flow uses the return of
 * aiFallbackParseSms(), not the event log.
 */
export async function recordParserEvent(params: {
  userId: number;
  outcome: AiFallbackOutcome | { status: "disabled" };
  regexOutcome: Record<string, unknown>;
  latencyMs: number;
}): Promise<void> {
  try {
    const { userId, outcome, regexOutcome, latencyMs } = params;
    const base = { userId, source: "sms" as const, regexOutcome, latencyMs };

    if (outcome.status === "disabled") {
      await db.insert(parserEvents).values({ ...base, eventKind: "parse_needs_review" });
      return;
    }
    if (outcome.status === "success") {
      // jsonb serialization chokes on bigint — convert amountCents to string
      // the same way sms-pipeline.ts:serializeParsed does.
      const aiOutcome: Record<string, unknown> = {
        ...outcome.parsed,
        amountCents: outcome.parsed.amountCents.toString(),
      };
      await db.insert(parserEvents).values({
        ...base,
        eventKind: "ai_fallback_success",
        aiOutcome,
        aiConfidence: outcome.confidence.toFixed(3),
        aiModel: outcome.ai.model,
        aiInputTokens: outcome.ai.tokensIn,
        aiOutputTokens: outcome.ai.tokensOut,
      });
      return;
    }
    if (outcome.status === "low_confidence") {
      await db.insert(parserEvents).values({
        ...base,
        eventKind: "ai_fallback_low_confidence",
        aiOutcome: outcome.rawAi as unknown as Record<string, unknown>,
        aiConfidence: outcome.confidence.toFixed(3),
        aiModel: outcome.ai.model,
        aiInputTokens: outcome.ai.tokensIn,
        aiOutputTokens: outcome.ai.tokensOut,
      });
      return;
    }
    // error
    await db.insert(parserEvents).values({
      ...base,
      eventKind: "ai_fallback_error",
      aiOutcome: { reason: outcome.reason, detail: outcome.detail ?? null },
    });
  } catch (err) {
    // A telemetry write failure must never break the ingestion path.
    log.error({ err, event: "parser_event_insert_failed" }, "parser_events insert failed");
  }
}

// Telemetry for the regex happy path. Non-blocking — telemetry failure
// must never break ingestion. Emitted BEFORE ingest so the SLO denominator
// counts "SMS we could understand" independent of DB-insert outcome.
export async function recordParseSuccess(params: {
  userId: number;
  regexOutcome: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(parserEvents).values({
      userId: params.userId,
      source: "sms",
      eventKind: "parse_outcome_success",
      regexOutcome: params.regexOutcome,
      latencyMs: 0,
    });
  } catch (err) {
    log.error({ err, event: "parser_event_insert_failed" }, "parser_events insert failed");
  }
}

// Telemetry for the skip path (OTP, promo, failed-tx notifications).
// Skips are excluded from the SLO denominator — not failures. Non-blocking.
export async function recordParseSkip(params: {
  userId: number;
  reason: string;
  raw: string;
}): Promise<void> {
  try {
    await db.insert(parserEvents).values({
      userId: params.userId,
      source: "sms",
      eventKind: "parse_outcome_skip",
      regexOutcome: { kind: "skip", reason: params.reason, raw: params.raw },
      latencyMs: 0,
    });
  } catch (err) {
    log.error({ err, event: "parser_event_insert_failed" }, "parser_events insert failed");
  }
}
