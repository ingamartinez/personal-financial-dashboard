import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, classificationCorrections, transactions, users } from "@/lib/db/schema";
import { copyCategorySeedsToUser } from "@/lib/auth/signup";
import type { CallClaudeOpts } from "@/lib/ai/anthropic-client";
import {
  SYNTHESIS_CLUSTER_FIELDS,
  SYNTHESIS_MAX_TOKENS,
  SYNTHESIS_MODEL,
  buildSynthesisUserPrompt,
  pickSynthesisCluster,
  synthesizeRulesForUser,
  type SynthesisCluster,
} from "./synthesize-rules";

const TAG = "SYN_RULE_TEST";

const mocks = vi.hoisted(() => ({
  callClaude: vi.fn(),
}));

vi.mock("@/lib/ai/anthropic-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/anthropic-client")>();
  return { ...actual, callClaude: mocks.callClaude };
});

async function createUser(email: string): Promise<number> {
  const [row] = await db.insert(users).values({ email, name: email }).returning({ id: users.id });
  await copyCategorySeedsToUser(row.id);
  return row.id;
}

async function createAccount(userId: number): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG} account`,
      institution: TAG,
      type: "savings",
      currency: "COP",
    })
    .returning({ id: accounts.id });
  return row.id;
}

let seq = 0;
async function seedCorrection(args: {
  userId: number;
  accountId: number;
  merchant: string;
  categorySlug: string;
}): Promise<number> {
  seq++;
  const [tx] = await db
    .insert(transactions)
    .values({
      userId: args.userId,
      accountId: args.accountId,
      occurredAt: new Date("2026-03-26T15:00:00Z"),
      amountCents: BigInt(-5000),
      currency: "COP",
      descriptionRaw: args.merchant,
      merchant: args.merchant,
      categorySlug: args.categorySlug,
      classificationMethod: "manual",
      source: "sms",
      externalId: `${TAG}-${seq}`,
    })
    .returning({ id: transactions.id });
  await db.insert(classificationCorrections).values({
    userId: args.userId,
    transactionId: tx.id,
    merchant: args.merchant,
    newCategorySlug: args.categorySlug,
  });
  return tx.id;
}

async function seedFiller(userId: number, accountId: number, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    seq++;
    await db.insert(transactions).values({
      userId,
      accountId,
      occurredAt: new Date("2026-03-26T15:00:00Z"),
      amountCents: BigInt(-1000),
      currency: "COP",
      descriptionRaw: `OTHER ${i}`,
      merchant: `OTHER ${i}`,
      categorySlug: "otros",
      classificationMethod: "unclassified",
      source: "sms",
      externalId: `${TAG}-fill-${seq}`,
    });
  }
}

async function cleanup() {
  await db.delete(users).where(sql`email LIKE ${"%" + TAG + "%"}`);
}

beforeEach(() => {
  mocks.callClaude.mockReset();
});

afterEach(cleanup);

describe("synthesis input whitelist", () => {
  it("exposes only categorySlug and merchants", () => {
    expect(SYNTHESIS_CLUSTER_FIELDS).toEqual(["categorySlug", "merchants"]);
  });

  it("SynthesisCluster cannot grow a field without this test turning red", () => {
    type Extra = Exclude<keyof SynthesisCluster, "categorySlug" | "merchants">;
    const extra: Extra extends never ? true : Extra = true;
    expect(extra).toBe(true);
  });

  it("callClaude still has no tools parameter", () => {
    type HasTools = "tools" extends keyof CallClaudeOpts<unknown> ? true : false;
    const hasTools: HasTools = false;
    expect(hasTools).toBe(false);
  });

  it("picks merchant names and slug, nothing else", () => {
    expect(
      pickSynthesisCluster({
        categorySlug: "uber-didi",
        merchants: ["  SYNUBERX TRIP  ", "SYNUBERX EATS"],
      }),
    ).toEqual({
      categorySlug: "uber-didi",
      merchants: ["SYNUBERX TRIP", "SYNUBERX EATS"],
    });
  });

  it("refuses a transaction-shaped value so financial fields cannot reach the model", () => {
    expect(() =>
      pickSynthesisCluster({
        categorySlug: "uber-didi",
        merchants: ["SYNUBERX TRIP"],
        amountCents: 14150000,
        descriptionRaw: "COMPRA MERCADOPAGO COLOMBIA",
      }),
    ).toThrow(/transaction-shaped/);
  });

  it("refuses any extra input key", () => {
    expect(() =>
      pickSynthesisCluster({
        categorySlug: "uber-didi",
        merchants: ["SYNUBERX TRIP"],
        note: "for context",
      }),
    ).toThrow(/extra input fields/);
  });

  it("user prompt contains merchant names and slugs, not amounts or descriptions", () => {
    const prompt = buildSynthesisUserPrompt([
      { categorySlug: "uber-didi", merchants: ["SYNUBERX TRIP", "SYNUBERX EATS"] },
    ]);
    expect(prompt).toContain("SYNUBERX TRIP");
    expect(prompt).toContain("uber-didi");
    expect(prompt).not.toMatch(/amount|occurred|account|descriptionRaw|COP|\$/i);
  });

  it("pins Haiku and a 512-token cap", () => {
    expect(SYNTHESIS_MODEL).toBe("claude-haiku-4-5");
    expect(SYNTHESIS_MAX_TOKENS).toBe(512);
  });
});

describe("synthesizeRulesForUser", () => {
  it("does not call the model when fewer than two distinct merchants were corrected", async () => {
    const userId = await createUser(`${TAG}-one@test.local`);
    const accountId = await createAccount(userId);
    await seedCorrection({
      userId,
      accountId,
      merchant: "SYNUBERX TRIP",
      categorySlug: "uber-didi",
    });

    const result = await synthesizeRulesForUser(userId);

    expect(mocks.callClaude).not.toHaveBeenCalled();
    expect(result).toEqual({ inserted: 0, skipped: 0, proposals: [] });
  });

  it("persists a pending synthesized proposal and does not activate a rule", async () => {
    const userId = await createUser(`${TAG}-ok@test.local`);
    const accountId = await createAccount(userId);
    await seedFiller(userId, accountId, 20);
    await seedCorrection({
      userId,
      accountId,
      merchant: "SYNUBERX TRIP",
      categorySlug: "uber-didi",
    });
    await seedCorrection({
      userId,
      accountId,
      merchant: "SYNUBERX EATS",
      categorySlug: "uber-didi",
    });

    mocks.callClaude.mockResolvedValue({
      data: {
        rules: [
          {
            pattern: "%SYNUBERX%",
            categorySlug: "uber-didi",
            coveredMerchants: ["SYNUBERX TRIP", "SYNUBERX EATS"],
          },
        ],
      },
      model: "claude-haiku-4-5",
      usage: { inputTokens: 80, outputTokens: 40, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });

    const [rulesBefore] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM classification_rules WHERE user_id = ${userId}
    `);

    const result = await synthesizeRulesForUser(userId);

    expect(result.inserted).toBe(1);
    expect(result.proposals[0]).toMatchObject({
      userId,
      pattern: "%SYNUBERX%",
      categorySlug: "uber-didi",
      source: "synthesized",
    });

    const [prop] = await db.execute<{ status: string; source: string; pattern: string }>(sql`
      SELECT status::text, source::text, pattern
      FROM rule_proposals WHERE id = ${result.proposals[0]!.id}
    `);
    expect(prop.status).toBe("pending");
    expect(prop.source).toBe("synthesized");
    expect(prop.pattern).toBe("%SYNUBERX%");

    const [rulesAfter] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM classification_rules WHERE user_id = ${userId}
    `);
    expect(rulesAfter.n).toBe(rulesBefore.n);

    const callOpts = mocks.callClaude.mock.calls[0]![0] as { feature: string; model: string };
    expect(callOpts.feature).toBe("rule-synthesis");
    expect(callOpts.model).toBe("claude-haiku-4-5");
    expect(Object.hasOwn(callOpts, "tools")).toBe(false);
  });

  it("drops a model slug that is not in the user's categories", async () => {
    const userId = await createUser(`${TAG}-slug@test.local`);
    const accountId = await createAccount(userId);
    await seedFiller(userId, accountId, 20);
    await seedCorrection({
      userId,
      accountId,
      merchant: "SYNUBERX TRIP",
      categorySlug: "uber-didi",
    });
    await seedCorrection({
      userId,
      accountId,
      merchant: "SYNUBERX EATS",
      categorySlug: "uber-didi",
    });

    mocks.callClaude.mockResolvedValue({
      data: {
        rules: [
          {
            pattern: "%SYNUBERX%",
            categorySlug: "muebles-inventados",
            coveredMerchants: ["SYNUBERX TRIP", "SYNUBERX EATS"],
          },
        ],
      },
      model: "claude-haiku-4-5",
      usage: { inputTokens: 80, outputTokens: 40, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });

    const result = await synthesizeRulesForUser(userId);
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(1);

    const rows = await db.execute(sql`
      SELECT 1 FROM rule_proposals WHERE user_id = ${userId}
    `);
    expect(rows).toHaveLength(0);
  });

  it("does not key opaque gateway corrections into a cluster", async () => {
    const userId = await createUser(`${TAG}-opaque@test.local`);
    const accountId = await createAccount(userId);
    await seedCorrection({
      userId,
      accountId,
      merchant: "MERCADOPAGO COLOMBIA",
      categorySlug: "hogar",
    });
    await seedCorrection({
      userId,
      accountId,
      merchant: "WOMPI*TIENDA",
      categorySlug: "hogar",
    });

    const result = await synthesizeRulesForUser(userId);
    expect(mocks.callClaude).not.toHaveBeenCalled();
    expect(result.inserted).toBe(0);
  });
});
