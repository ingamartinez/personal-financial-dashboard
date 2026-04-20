import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, parserEvents, transactions, users } from "@/lib/db/schema";
import { ingestParsed } from "./sms-pipeline";
import type { ParseResult } from "./sms-bancolombia";

// Covers the AI-fallback branch added in #257. The regex-pass path is
// exercised indirectly through the existing SMS route + parser tests; this
// file focuses on the new needs_review flow with the three terminal
// outcomes: disabled, success, low_confidence.

const TAG = "+pipeline-test@findash.local";

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
      input_tokens: 200,
      output_tokens: 40,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

function mockFetch(responseBody: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

async function setupUserWithAccount(flag: boolean | undefined): Promise<{
  userId: number;
  accountId: number;
}> {
  const [u] = await db
    .insert(users)
    .values({
      email: `${crypto.randomUUID()}${TAG}`,
      name: "Pipeline test",
      role: "user",
      active: true,
      googleSub: `sub-${crypto.randomUUID()}`,
      featureFlags: flag === undefined ? {} : { aiFallbackEnabled: flag },
    })
    .returning({ id: users.id });
  const [a] = await db
    .insert(accounts)
    .values({
      userId: u.id,
      institution: "Bancolombia",
      name: "TC Visa *2575",
      type: "credit_card",
      currency: "COP",
      active: true,
      metadata: { last4s: ["2575"] },
    })
    .returning({ id: accounts.id });
  return { userId: u.id, accountId: a.id };
}

async function cleanup() {
  const rows = await db.select({ id: users.id, email: users.email }).from(users);
  const ids = rows.filter((r) => r.email.endsWith(TAG)).map((r) => r.id);
  if (ids.length === 0) return;
  await db.delete(transactions).where(inArray(transactions.userId, ids));
  await db.delete(parserEvents).where(inArray(parserEvents.userId, ids));
  await db.delete(accounts).where(inArray(accounts.userId, ids));
  await db.delete(users).where(inArray(users.id, ids));
}

const rawSms =
  "Bancolombia: mensaje raro que el regex no entiende ... RAPPI 45000 COP *2575 15/04/2026 19:30";
const needsReviewInput: ParseResult = {
  kind: "needs_review",
  reason: "unknown_pattern",
  raw: rawSms,
};

describe("ingestParsed — needs_review + AI fallback", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("records parse_needs_review and errors when fallback is disabled", async () => {
    const { userId } = await setupUserWithAccount(false);

    const outcome = await ingestParsed(userId, needsReviewInput);

    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") throw new Error("type guard");
    expect(outcome.reason).toContain("ai fallback disabled");

    // No tx should be created.
    const txs = await db.select().from(transactions).where(eq(transactions.userId, userId));
    expect(txs).toHaveLength(0);

    // Exactly one parser_events row, kind = parse_needs_review.
    const events = await db.select().from(parserEvents).where(eq(parserEvents.userId, userId));
    expect(events).toHaveLength(1);
    expect(events[0].eventKind).toBe("parse_needs_review");
    expect(events[0].aiModel).toBeNull();
  });

  it("creates tx + records ai_fallback_success on high-confidence AI output", async () => {
    const { userId, accountId } = await setupUserWithAccount(true);

    const outcome = await ingestParsed(userId, needsReviewInput, {
      aiFallbackFetchImpl: mockFetch(
        fakeMessageResponse({
          kind: "purchase",
          amountCents: "4500000",
          currency: "COP",
          merchant: "RAPPI",
          cardLast4: "2575",
          cardKind: "credit",
          occurredOn: "2026-04-15",
          occurredTime: "19:30",
          confidence: 0.95,
        }),
      ),
    });

    expect(outcome.status).toBe("inserted");
    if (outcome.status !== "inserted") throw new Error("type guard");
    expect(outcome.via).toBe("ai_fallback");

    // Tx should be on the 2575 account with parsedBy marker in raw_data.
    const [tx] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.userId, userId))
      .orderBy(desc(transactions.id))
      .limit(1);
    expect(tx.accountId).toBe(accountId);
    // Purchase: negative amountCents.
    expect(tx.amountCents).toBe(BigInt("-4500000"));
    expect(tx.currency).toBe("COP");
    expect(tx.merchant).toBe("RAPPI");
    const raw = tx.rawData as Record<string, unknown>;
    expect(raw.parsedBy).toBe("ai_fallback");
    expect(raw.aiConfidence).toBe(0.95);

    // parser_events has ai_fallback_success with token counts.
    const [ev] = await db.select().from(parserEvents).where(eq(parserEvents.userId, userId));
    expect(ev.eventKind).toBe("ai_fallback_success");
    expect(ev.aiInputTokens).toBe(200);
    expect(ev.aiConfidence).toBe("0.950");
    expect(ev.latencyMs).not.toBeNull();
  });

  it("records ai_fallback_low_confidence and returns error (no tx) when AI confidence < 0.8", async () => {
    const { userId } = await setupUserWithAccount(true);

    const outcome = await ingestParsed(userId, needsReviewInput, {
      aiFallbackFetchImpl: mockFetch(
        fakeMessageResponse({
          kind: "purchase",
          amountCents: "0",
          currency: "COP",
          merchant: "?",
          cardLast4: "0000",
          cardKind: "credit",
          occurredOn: "2026-04-15",
          occurredTime: "00:00",
          confidence: 0.2,
        }),
      ),
    });

    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") throw new Error("type guard");
    expect(outcome.reason).toContain("low_confidence");

    const txs = await db.select().from(transactions).where(eq(transactions.userId, userId));
    expect(txs).toHaveLength(0);

    const [ev] = await db.select().from(parserEvents).where(eq(parserEvents.userId, userId));
    expect(ev.eventKind).toBe("ai_fallback_low_confidence");
    expect(ev.aiConfidence).toBe("0.200");
  });
});
