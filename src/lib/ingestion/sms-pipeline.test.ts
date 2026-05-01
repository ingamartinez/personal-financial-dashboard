import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, parserEvents, transactions, users } from "@/lib/db/schema";
import { ingestParsed } from "./sms-pipeline";
import type { ParseResult } from "./sms-bancolombia";
import { parseSmsBancolombia } from "./sms-bancolombia";

// Covers parser telemetry to parser_events:
//   - #257 AI-fallback branch: parse_needs_review (disabled), ai_fallback_success,
//     ai_fallback_low_confidence.
//   - #329 PR1 parse-outcome logging: parse_outcome_success (regex happy path),
//     parse_outcome_skip (non-transactional SMS). Pre-requisite for migrating
//     SLO #1 to compute from parser_events.

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
    // Raw SMS is persisted for drill-down debugging (#329 PR2).
    const regex = events[0].regexOutcome as Record<string, unknown>;
    expect(regex.raw).toBe(rawSms);
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

describe("ingestParsed — parse outcome telemetry (#329 PR1)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("records parse_outcome_skip for skip inputs and creates no tx", async () => {
    const { userId } = await setupUserWithAccount(undefined);

    const skipInput: ParseResult = {
      kind: "skip",
      reason: "non_transactional",
      raw: "Bancolombia: Tu código de verificación es 123456",
    };
    const outcome = await ingestParsed(userId, skipInput);

    expect(outcome.status).toBe("skipped");

    const txs = await db.select().from(transactions).where(eq(transactions.userId, userId));
    expect(txs).toHaveLength(0);

    const events = await db.select().from(parserEvents).where(eq(parserEvents.userId, userId));
    expect(events).toHaveLength(1);
    expect(events[0].eventKind).toBe("parse_outcome_skip");
    expect(events[0].aiModel).toBeNull();
    expect(events[0].aiConfidence).toBeNull();
    const regex = events[0].regexOutcome as Record<string, unknown>;
    expect(regex.kind).toBe("skip");
    expect(regex.reason).toBe("non_transactional");
    // Raw SMS is persisted for drill-down debugging (#329 PR2).
    expect(regex.raw).toBe(skipInput.raw);
  });

  it("records parse_outcome_success for the regex happy path and inserts the tx", async () => {
    const { userId, accountId } = await setupUserWithAccount(undefined);

    const purchaseInput: ParseResult = {
      kind: "purchase",
      amountCents: BigInt(4500000),
      currency: "COP",
      merchant: "RAPPI",
      cardLast4: "2575",
      cardKind: "credit",
      occurredOn: "2026-04-15",
      occurredTime: "19:30",
      externalId: "bcol-sms:regex-happy-path-test",
      raw: "Bancolombia: Compraste $45.000,00 en RAPPI con tu T.Cred *2575, el 15/04/2026 19:30",
    };

    const outcome = await ingestParsed(userId, purchaseInput);

    expect(outcome.status).toBe("inserted");
    if (outcome.status !== "inserted") throw new Error("type guard");
    // The AI-fallback path tags inserts with via=ai_fallback; regex path leaves it undefined.
    expect(outcome.via).toBeUndefined();

    const [tx] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.userId, userId))
      .limit(1);
    expect(tx.accountId).toBe(accountId);
    expect(tx.amountCents).toBe(BigInt("-4500000"));

    const events = await db.select().from(parserEvents).where(eq(parserEvents.userId, userId));
    expect(events).toHaveLength(1);
    expect(events[0].eventKind).toBe("parse_outcome_success");
    expect(events[0].aiModel).toBeNull();
    expect(events[0].aiConfidence).toBeNull();
    const regex = events[0].regexOutcome as Record<string, unknown>;
    expect(regex.kind).toBe("purchase");
    expect(regex.merchant).toBe("RAPPI");
    // serializeParsed stringifies bigint for jsonb safety.
    expect(regex.amountCents).toBe("4500000");
  });

  it("emits parse_outcome_success even if account routing fails (parse succeeded, ingest failed)", async () => {
    const { userId } = await setupUserWithAccount(undefined);

    // cardLast4=9999 has no matching account → ingestParsedSms returns error,
    // but the regex parse itself succeeded and must still count in the SLO.
    const purchaseInput: ParseResult = {
      kind: "purchase",
      amountCents: BigInt(1000000),
      currency: "COP",
      merchant: "AMAZON",
      cardLast4: "9999",
      cardKind: "credit",
      occurredOn: "2026-04-15",
      occurredTime: "10:00",
      externalId: "bcol-sms:no-account-test",
      raw: "Bancolombia: Compraste $10.000,00 en AMAZON con tu T.Cred *9999",
    };

    const outcome = await ingestParsed(userId, purchaseInput);

    expect(outcome.status).toBe("error");
    const events = await db.select().from(parserEvents).where(eq(parserEvents.userId, userId));
    expect(events).toHaveLength(1);
    expect(events[0].eventKind).toBe("parse_outcome_success");
  });
});

// ---------------------------------------------------------------------------
// Cartera TC wire path (#688)
// ---------------------------------------------------------------------------

const CARTERA_TC_SMS =
  "Bancolombia confirma compra de cartera por $29,000,000.00 en su TC AMEX *5367. La tasa es de 1.39% y el plazo de 60 meses.";

const TAG_CARTERA = "+cartera-tc-test@findash.local";

async function setupCarteraUsers(): Promise<{
  userId: number;
  savingsId: number;
  tcId: number;
}> {
  const [u] = await db
    .insert(users)
    .values({
      email: `${crypto.randomUUID()}${TAG_CARTERA}`,
      name: "Cartera TC test",
      role: "user",
      active: true,
      googleSub: `sub-cartera-${crypto.randomUUID()}`,
      featureFlags: {},
    })
    .returning({ id: users.id });
  const [savings] = await db
    .insert(accounts)
    .values({
      userId: u.id,
      institution: "Bancolombia",
      name: "Ahorros *6126",
      type: "savings",
      currency: "COP",
      active: true,
      metadata: { last4s: ["6126"] },
    })
    .returning({ id: accounts.id });
  const [tc] = await db
    .insert(accounts)
    .values({
      userId: u.id,
      institution: "Bancolombia",
      name: "Amex *5367",
      type: "credit_card",
      currency: "COP",
      active: true,
      metadata: { last4s: ["5367"] },
    })
    .returning({ id: accounts.id });
  return { userId: u.id, savingsId: savings.id, tcId: tc.id };
}

async function cleanupCartera() {
  const rows = await db.select({ id: users.id, email: users.email }).from(users);
  const ids = rows.filter((r) => r.email.endsWith(TAG_CARTERA)).map((r) => r.id);
  if (ids.length === 0) return;
  await db.delete(transactions).where(inArray(transactions.userId, ids));
  await db.delete(parserEvents).where(inArray(parserEvents.userId, ids));
  await db.delete(accounts).where(inArray(accounts.userId, ids));
  await db.delete(users).where(inArray(users.id, ids));
}

describe("ingestParsed — cartera_tc wire path (#688)", () => {
  beforeEach(cleanupCartera);
  afterEach(cleanupCartera);

  it("SMS → parse → 2 txs in DB with correct fields", async () => {
    const { userId, savingsId, tcId } = await setupCarteraUsers();

    const parsed = parseSmsBancolombia(CARTERA_TC_SMS);
    expect(parsed.kind).toBe("cartera_tc");

    const outcome = await ingestParsed(userId, parsed);
    expect(outcome.status).toBe("inserted");

    // Both legs should be present
    const txs = await db
      .select()
      .from(transactions)
      .where(eq(transactions.userId, userId))
      .orderBy(transactions.accountId);

    expect(txs).toHaveLength(2);

    const savingsTx = txs.find((t) => t.accountId === savingsId);
    const tcTx = txs.find((t) => t.accountId === tcId);

    expect(savingsTx).toBeDefined();
    expect(tcTx).toBeDefined();

    if (!savingsTx || !tcTx) throw new Error("type guard");

    // Savings leg: positive (credit into savings)
    expect(savingsTx.amountCents).toBe(BigInt(2_900_000_000));
    expect(savingsTx.currency).toBe("COP");
    expect(savingsTx.channel).toBe("transfer");
    expect(savingsTx.categorySlug).toBeNull();
    const savingsRaw = savingsTx.rawData as Record<string, unknown>;
    expect(savingsRaw.kind).toBe("cartera_tc");
    expect(savingsRaw.role).toBe("savings_disbursement");

    // TC leg: negative (deferred debit on TC), with installment plan
    expect(tcTx.amountCents).toBe(BigInt(-2_900_000_000));
    expect(tcTx.currency).toBe("COP");
    expect(tcTx.channel).toBe("transfer");
    expect(tcTx.categorySlug).toBeNull();
    expect(tcTx.installmentsTotal).toBe(60);
    expect(tcTx.installmentRateEmX10k).toBe(13900);
    const tcRaw = tcTx.rawData as Record<string, unknown>;
    expect(tcRaw.kind).toBe("cartera_tc");
    expect(tcRaw.role).toBe("tc_debit");

    // Both legs share the same transferGroupId
    expect(savingsTx.transferGroupId).not.toBeNull();
    expect(savingsTx.transferGroupId).toBe(tcTx.transferGroupId);

    // External IDs are the leg-namespaced variants
    expect(savingsTx.externalId).toMatch(/:savings$/);
    expect(tcTx.externalId).toMatch(/:tc$/);
  });

  it("re-ingesting the same SMS returns duplicated (idempotent)", async () => {
    const { userId } = await setupCarteraUsers();

    const parsed = parseSmsBancolombia(CARTERA_TC_SMS);
    const first = await ingestParsed(userId, parsed);
    expect(first.status).toBe("inserted");

    const second = await ingestParsed(userId, parsed);
    expect(second.status).toBe("duplicated");

    // Still only 2 txs in DB
    const txs = await db.select().from(transactions).where(eq(transactions.userId, userId));
    expect(txs).toHaveLength(2);
  });

  it("returns error when TC card last4 is unknown", async () => {
    const { userId } = await setupCarteraUsers();

    // SMS with a different last4 that no account claims
    const unknown4Sms =
      "Bancolombia confirma compra de cartera por $5,000,000.00 en su TC AMEX *9999. La tasa es de 1.39% y el plazo de 60 meses.";
    const parsed = parseSmsBancolombia(unknown4Sms);
    expect(parsed.kind).toBe("cartera_tc");

    const outcome = await ingestParsed(userId, parsed);
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") throw new Error("type guard");
    expect(outcome.reason).toContain("9999");

    const txs = await db.select().from(transactions).where(eq(transactions.userId, userId));
    expect(txs).toHaveLength(0);
  });

  it("returns error when user has 0 Bancolombia COP savings accounts", async () => {
    // Create user with ONLY a TC account, no savings
    const [u] = await db
      .insert(users)
      .values({
        email: `${crypto.randomUUID()}${TAG_CARTERA}`,
        name: "No savings user",
        role: "user",
        active: true,
        googleSub: `sub-nosavings-${crypto.randomUUID()}`,
        featureFlags: {},
      })
      .returning({ id: users.id });
    await db.insert(accounts).values({
      userId: u.id,
      institution: "Bancolombia",
      name: "Amex *5367",
      type: "credit_card",
      currency: "COP",
      active: true,
      metadata: { last4s: ["5367"] },
    });

    const parsed = parseSmsBancolombia(CARTERA_TC_SMS);
    const outcome = await ingestParsed(u.id, parsed);
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") throw new Error("type guard");
    expect(outcome.reason).toContain("savings");

    const txs = await db.select().from(transactions).where(eq(transactions.userId, u.id));
    expect(txs).toHaveLength(0);
  });

  it("returns error when user has 2+ Bancolombia COP savings accounts (ambiguous)", async () => {
    const [u] = await db
      .insert(users)
      .values({
        email: `${crypto.randomUUID()}${TAG_CARTERA}`,
        name: "Ambiguous savings user",
        role: "user",
        active: true,
        googleSub: `sub-ambig-${crypto.randomUUID()}`,
        featureFlags: {},
      })
      .returning({ id: users.id });
    // Two savings accounts
    await db.insert(accounts).values([
      {
        userId: u.id,
        institution: "Bancolombia",
        name: "Ahorros *6126",
        type: "savings",
        currency: "COP",
        active: true,
        metadata: { last4s: ["6126"] },
      },
      {
        userId: u.id,
        institution: "Bancolombia",
        name: "Ahorros *9999",
        type: "savings",
        currency: "COP",
        active: true,
        metadata: { last4s: ["9999"] },
      },
      {
        userId: u.id,
        institution: "Bancolombia",
        name: "Amex *5367",
        type: "credit_card",
        currency: "COP",
        active: true,
        metadata: { last4s: ["5367"] },
      },
    ]);

    const parsed = parseSmsBancolombia(CARTERA_TC_SMS);
    const outcome = await ingestParsed(u.id, parsed);
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") throw new Error("type guard");
    expect(outcome.reason).toContain("ambiguous");

    const txs = await db.select().from(transactions).where(eq(transactions.userId, u.id));
    expect(txs).toHaveLength(0);
  });
});
