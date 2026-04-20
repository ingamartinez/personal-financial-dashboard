import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { parserEvents, users } from "@/lib/db/schema";
import { aiFallbackParseSms, isAiFallbackEnabled, recordParserEvent } from "./sms-ai-fallback";

// ---------------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------------

function fakeMessageResponse(payload: unknown): Record<string, unknown> {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text: JSON.stringify(payload) }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

function mockFetch(
  responseBody: unknown,
  init?: { status?: number; errorBody?: unknown },
): typeof fetch {
  return (async () => {
    const status = init?.status ?? 200;
    const body = status === 200 ? responseBody : (init?.errorBody ?? { error: "oops" });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// aiFallbackParseSms — pure behavior, mocked HTTP
// ---------------------------------------------------------------------------

describe("aiFallbackParseSms", () => {
  const validHighConfidence = {
    kind: "purchase",
    amountCents: "4500000",
    currency: "COP",
    merchant: "RAPPI",
    cardLast4: "2575",
    cardKind: "credit",
    occurredOn: "2026-04-15",
    occurredTime: "19:30",
    confidence: 0.95,
  };

  it("returns success with a ParsedSms when confidence ≥ 0.8", async () => {
    const result = await aiFallbackParseSms(
      "Bancolombia: weird format ... RAPPI 45.000 2575 15/04/2026 19:30",
      {
        apiKey: "sk-test",
        fetchImpl: mockFetch(fakeMessageResponse(validHighConfidence)),
      },
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("type guard");
    expect(result.parsed.kind).toBe("purchase");
    expect(result.parsed.amountCents).toBe(BigInt("4500000"));
    expect(result.parsed.currency).toBe("COP");
    // Purchases carry merchant, not sender; guard the union.
    if (result.parsed.kind === "purchase") {
      expect(result.parsed.merchant).toBe("RAPPI");
      expect(result.parsed.cardLast4).toBe("2575");
    }
    expect(result.confidence).toBe(0.95);
    expect(result.ai.model).toBe("claude-haiku-4-5-20251001");
    expect(result.ai.tokensIn).toBe(120);
  });

  it("returns low_confidence (not success) when confidence < 0.8", async () => {
    const result = await aiFallbackParseSms("Bancolombia: something ambiguous", {
      apiKey: "sk-test",
      fetchImpl: mockFetch(fakeMessageResponse({ ...validHighConfidence, confidence: 0.4 })),
    });

    expect(result.status).toBe("low_confidence");
    if (result.status !== "low_confidence") throw new Error("type guard");
    expect(result.confidence).toBe(0.4);
    expect(result.rawAi.merchant).toBe("RAPPI");
  });

  it("returns error:api_error on non-2xx responses", async () => {
    const result = await aiFallbackParseSms("Bancolombia: whatever", {
      apiKey: "sk-test",
      fetchImpl: mockFetch(
        {},
        {
          status: 500,
          errorBody: { type: "error", error: { type: "api_error", message: "boom" } },
        },
      ),
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("type guard");
    expect(result.reason).toBe("api_error");
    expect(result.detail).toContain("500");
  });

  it("returns error:api_error on 429 rate limit", async () => {
    const result = await aiFallbackParseSms("Bancolombia: whatever", {
      apiKey: "sk-test",
      fetchImpl: mockFetch(
        {},
        {
          status: 429,
          errorBody: { type: "error", error: { type: "rate_limit_error", message: "slow" } },
        },
      ),
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("type guard");
    expect(result.reason).toBe("api_error");
    expect(result.detail).toContain("429");
  });
});

// ---------------------------------------------------------------------------
// isAiFallbackEnabled — DB-backed, covers env + per-user override precedence
// ---------------------------------------------------------------------------

const TAG = "+ai-fallback-test@findash.local";

async function createTestUser(flag: boolean | undefined): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `${crypto.randomUUID()}${TAG}`,
      name: "AI fallback test",
      role: "user",
      active: true,
      googleSub: `sub-${crypto.randomUUID()}`,
      featureFlags: flag === undefined ? {} : { aiFallbackEnabled: flag },
    })
    .returning({ id: users.id });
  return row.id;
}

// Collect IDs by email suffix then cascade-delete — safer than raw SQL LIKE.
async function cleanup() {
  const rows = await db.select({ id: users.id, email: users.email }).from(users);
  const ids = rows.filter((r) => r.email.endsWith(TAG)).map((r) => r.id);
  if (ids.length === 0) return;
  await db.delete(parserEvents).where(inArray(parserEvents.userId, ids));
  await db.delete(users).where(inArray(users.id, ids));
}

describe("isAiFallbackEnabled", () => {
  const originalEnv = process.env.AI_FALLBACK_ENABLED;

  beforeEach(cleanup);
  afterEach(async () => {
    await cleanup();
    if (originalEnv === undefined) delete process.env.AI_FALLBACK_ENABLED;
    else process.env.AI_FALLBACK_ENABLED = originalEnv;
  });

  it("defers to env var when user has no flag set", async () => {
    const id = await createTestUser(undefined);

    process.env.AI_FALLBACK_ENABLED = "true";
    expect(await isAiFallbackEnabled(id)).toBe(true);

    process.env.AI_FALLBACK_ENABLED = "false";
    expect(await isAiFallbackEnabled(id)).toBe(false);

    delete process.env.AI_FALLBACK_ENABLED;
    expect(await isAiFallbackEnabled(id)).toBe(false);
  });

  it("per-user flag=true overrides env var=false", async () => {
    const id = await createTestUser(true);
    process.env.AI_FALLBACK_ENABLED = "false";
    expect(await isAiFallbackEnabled(id)).toBe(true);
  });

  it("per-user flag=false overrides env var=true", async () => {
    const id = await createTestUser(false);
    process.env.AI_FALLBACK_ENABLED = "true";
    expect(await isAiFallbackEnabled(id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recordParserEvent — persists correct event_kind per outcome
// ---------------------------------------------------------------------------

describe("recordParserEvent", () => {
  let userId: number;

  beforeEach(async () => {
    await cleanup();
    userId = await createTestUser(undefined);
  });
  afterEach(cleanup);

  const regexOutcome = { kind: "needs_review", reason: "unknown_pattern" };

  it("writes parse_needs_review when outcome is disabled", async () => {
    await recordParserEvent({
      userId,
      outcome: { status: "disabled" },
      regexOutcome,
      latencyMs: 0,
    });
    const rows = await db.select().from(parserEvents).where(eq(parserEvents.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].eventKind).toBe("parse_needs_review");
    expect(rows[0].aiModel).toBeNull();
  });

  it("writes ai_fallback_success with AI metadata", async () => {
    await recordParserEvent({
      userId,
      outcome: {
        status: "success",
        parsed: {
          kind: "purchase",
          amountCents: BigInt(4500000),
          currency: "COP",
          merchant: "RAPPI",
          cardLast4: "2575",
          cardKind: "credit",
          occurredOn: "2026-04-15",
          occurredTime: "19:30",
          externalId: "bcol-sms:abc123",
          raw: "Bancolombia: ...",
        },
        confidence: 0.93,
        ai: { model: "claude-haiku-4-5", tokensIn: 120, tokensOut: 30 },
      },
      regexOutcome,
      latencyMs: 1800,
    });
    const [row] = await db.select().from(parserEvents).where(eq(parserEvents.userId, userId));
    expect(row.eventKind).toBe("ai_fallback_success");
    expect(row.aiModel).toBe("claude-haiku-4-5");
    expect(row.aiInputTokens).toBe(120);
    expect(row.aiOutputTokens).toBe(30);
    expect(row.latencyMs).toBe(1800);
    // numeric(4,3) comes back as a string from Postgres; 0.93 → "0.930".
    expect(row.aiConfidence).toBe("0.930");
  });

  it("writes ai_fallback_low_confidence with the rawAi output", async () => {
    await recordParserEvent({
      userId,
      outcome: {
        status: "low_confidence",
        confidence: 0.42,
        rawAi: {
          kind: "purchase",
          amountCents: "1000",
          currency: "COP",
          merchant: "?",
          cardLast4: "0000",
          cardKind: "credit",
          occurredOn: "2026-04-15",
          occurredTime: "00:00",
          confidence: 0.42,
        },
        ai: { model: "claude-haiku-4-5", tokensIn: 120, tokensOut: 30 },
      },
      regexOutcome,
      latencyMs: 1500,
    });
    const [row] = await db.select().from(parserEvents).where(eq(parserEvents.userId, userId));
    expect(row.eventKind).toBe("ai_fallback_low_confidence");
    expect(row.aiConfidence).toBe("0.420");
  });

  it("writes ai_fallback_error with detail", async () => {
    await recordParserEvent({
      userId,
      outcome: { status: "error", reason: "timeout" },
      regexOutcome,
      latencyMs: 2000,
    });
    const [row] = await db.select().from(parserEvents).where(eq(parserEvents.userId, userId));
    expect(row.eventKind).toBe("ai_fallback_error");
    const ai = row.aiOutcome as Record<string, unknown>;
    expect(ai.reason).toBe("timeout");
  });

  it("filters work: ai_fallback_* partial index covers the three fallback kinds", async () => {
    // This is really a smoke test that the partial index predicate matches
    // what we write — if event_kind values diverge the index silently loses
    // coverage on the dashboard drill-down.
    const outcomes = ["ai_fallback_success", "ai_fallback_low_confidence", "ai_fallback_error"];
    for (const kind of outcomes) {
      await db.insert(parserEvents).values({
        userId,
        source: "sms",
        eventKind: kind as never,
      });
    }
    const rows = await db
      .select()
      .from(parserEvents)
      .where(
        and(eq(parserEvents.userId, userId), inArray(parserEvents.eventKind, outcomes as never[])),
      );
    expect(rows).toHaveLength(3);
  });
});
