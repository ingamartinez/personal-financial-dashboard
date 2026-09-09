import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { merchantKnowledge, merchantKnowledgeHints, transactions, users } from "@/lib/db/schema";
import { copyCategorySeedsToUser } from "@/lib/auth/signup";

// ---------------------------------------------------------------------------
// Mock external dependencies — we test the pipeline's DB filtering logic,
// not the AI or rule engine themselves.
// ---------------------------------------------------------------------------

vi.mock("@/lib/classification/enqueue", () => ({
  enqueueAskUser: vi.fn().mockResolvedValue(undefined),
  enqueueClassification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/classification/ai", () => ({
  classifyBatchWithAi: vi.fn().mockResolvedValue({
    classifications: [],
    model: "claude-sonnet-5",
    usage: { inputTokens: 0, outputTokens: 0 },
  }),
}));

vi.mock("@/lib/classification/rules", () => ({
  classifyByRule: vi.fn().mockResolvedValue(null),
}));

const { classifyUnclassifiedBatch, AI_BATCH_SIZE } = await import("./pipeline");
const { classifyBatchWithAi } = await import("./ai");
const mockClassifyBatch = vi.mocked(classifyBatchWithAi);

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

const TEST_USER_A = 1; // bootstrap user — always exists in findash_test
const TEST_USER_B = 2; // second user seeded by db:seed:test

async function defaultAccountId(userId: number): Promise<number> {
  const [row] = await db.execute<{ id: number }>(sql`
    SELECT id FROM accounts WHERE user_id = ${userId} ORDER BY id LIMIT 1
  `);
  if (!row) throw new Error(`No account for user ${userId}`);
  return row.id;
}

async function seedUnclassifiedTx(args: {
  userId: number;
  accountId: number;
  externalId: string;
  descriptionRaw?: string;
  merchant?: string | null;
  canonicalMerchant?: string | null;
}): Promise<number> {
  const [row] = await db.execute<{ id: number }>(sql`
    INSERT INTO transactions (
      user_id, account_id, occurred_at, amount_cents, currency,
      description_raw, merchant, canonical_merchant,
      classification_method, source, external_id
    ) VALUES (
      ${args.userId}, ${args.accountId}, now(), -10000, 'COP',
      ${args.descriptionRaw ?? "pipeline-test"}, ${args.merchant ?? null},
      ${args.canonicalMerchant ?? null},
      'unclassified'::classification_method,
      'sms', ${args.externalId}
    )
    RETURNING id
  `);
  return row.id;
}

async function cleanupTestTxs() {
  await db.execute(sql`
    DELETE FROM ingestion_logs WHERE source = 'manual' AND payload->>'kind' = 'ai-classify'
      AND started_at > now() - interval '1 hour'
  `);
  await db.execute(sql`
    DELETE FROM transactions WHERE external_id LIKE 'pipeline-test:%'
  `);
}

// ---------------------------------------------------------------------------
// opts.txIds filtering
// ---------------------------------------------------------------------------

describe("classifyUnclassifiedBatch — opts.txIds", () => {
  let accountA: number;

  beforeEach(async () => {
    await cleanupTestTxs();
    accountA = await defaultAccountId(TEST_USER_A);
    mockClassifyBatch.mockClear();
  });

  afterEach(cleanupTestTxs);

  it("returns picked=0 immediately when txIds is empty array", async () => {
    const result = await classifyUnclassifiedBatch(TEST_USER_A, { txIds: [] });
    expect(result.picked).toBe(0);
    expect(result.classifiedIds).toEqual([]);
    expect(mockClassifyBatch).not.toHaveBeenCalled();
  });

  it("only picks transactions matching the given txIds", async () => {
    const txA = await seedUnclassifiedTx({
      userId: TEST_USER_A,
      accountId: accountA,
      externalId: "pipeline-test:filter-A",
    });
    await seedUnclassifiedTx({
      userId: TEST_USER_A,
      accountId: accountA,
      externalId: "pipeline-test:filter-B",
    });

    // Only pass txA's id
    mockClassifyBatch.mockResolvedValueOnce({
      classifications: [{ id: txA, categorySlug: "alimentacion", confidence: 80 }],
      model: "claude-sonnet-5",
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    const result = await classifyUnclassifiedBatch(TEST_USER_A, { txIds: [txA] });

    // Pipeline should have only sent txA to the AI
    expect(result.picked).toBe(1);
    expect(mockClassifyBatch).toHaveBeenCalledTimes(1);
    const callArg = mockClassifyBatch.mock.calls[0][0];
    expect(callArg.transactions).toHaveLength(1);
    expect(callArg.transactions[0].id).toBe(txA);
  });

  it("ignores already-classified txs even when their id is in txIds", async () => {
    // Seed as 'manual' (already classified)
    const [classifiedRow] = await db.execute<{ id: number }>(sql`
      INSERT INTO transactions (
        user_id, account_id, occurred_at, amount_cents, currency,
        description_raw, category_slug, classification_method, source, external_id
      ) VALUES (
        ${TEST_USER_A}, ${accountA}, now(), -10000, 'COP',
        'pipeline-test', 'alimentacion', 'manual'::classification_method,
        'sms', 'pipeline-test:already-classified'
      )
      RETURNING id
    `);

    const result = await classifyUnclassifiedBatch(TEST_USER_A, {
      txIds: [classifiedRow.id],
    });

    // The WHERE clause includes classification_method = 'unclassified', so
    // this row must NOT be picked
    expect(result.picked).toBe(0);
    expect(mockClassifyBatch).not.toHaveBeenCalled();
  });

  it("tenant isolation: txIds from userA are NOT processed for userB (WHERE includes user_id)", async () => {
    // Seed tx for userA
    const userATxId = await seedUnclassifiedTx({
      userId: TEST_USER_A,
      accountId: accountA,
      externalId: "pipeline-test:tenant-A",
    });

    // Run pipeline AS userB with userA's txId
    const result = await classifyUnclassifiedBatch(TEST_USER_B, { txIds: [userATxId] });

    // userB's pipeline must not pick userA's tx
    expect(result.picked).toBe(0);
    expect(mockClassifyBatch).not.toHaveBeenCalled();

    // userA's tx must remain unclassified
    const [row] = await db
      .select({ method: transactions.classificationMethod })
      .from(transactions)
      .where(and(eq(transactions.id, userATxId), eq(transactions.userId, TEST_USER_A)));
    expect(row?.method).toBe("unclassified");
  });

  it("respects AI_BATCH_SIZE — never sends more than 20 to the AI per call", async () => {
    const ids: number[] = [];
    for (let i = 0; i < AI_BATCH_SIZE + 5; i++) {
      const id = await seedUnclassifiedTx({
        userId: TEST_USER_A,
        accountId: accountA,
        externalId: `pipeline-test:batch-limit-${i}`,
      });
      ids.push(id);
    }

    mockClassifyBatch.mockResolvedValueOnce({
      classifications: [],
      model: "claude-sonnet-5",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await classifyUnclassifiedBatch(TEST_USER_A, { txIds: ids });

    // Pipeline limits to AI_BATCH_SIZE regardless of how many txIds were requested
    expect(result.picked).toBeLessThanOrEqual(AI_BATCH_SIZE);
  });
});

// ---------------------------------------------------------------------------
// Default behavior (no opts) — sanity check existing path is unchanged
// ---------------------------------------------------------------------------

describe("classifyUnclassifiedBatch — default (no opts)", () => {
  let accountA: number;

  beforeEach(async () => {
    await cleanupTestTxs();
    accountA = await defaultAccountId(TEST_USER_A);
    mockClassifyBatch.mockClear();
  });

  afterEach(cleanupTestTxs);

  it("returns picked=0 when no unclassified transactions exist", async () => {
    // Ensure no test-txs exist for this user with classification_method=unclassified
    const result = await classifyUnclassifiedBatch(TEST_USER_A);
    expect(result.picked).toBe(0);
    expect(result.classifiedIds).toEqual([]);
    expect(mockClassifyBatch).not.toHaveBeenCalled();
  });

  it("picks unclassified txs up to AI_BATCH_SIZE when called with no opts", async () => {
    // Seed 3 unclassified txs
    for (let i = 0; i < 3; i++) {
      await seedUnclassifiedTx({
        userId: TEST_USER_A,
        accountId: accountA,
        externalId: `pipeline-test:default-${i}`,
      });
    }

    mockClassifyBatch.mockResolvedValueOnce({
      classifications: [],
      model: "claude-sonnet-5",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await classifyUnclassifiedBatch(TEST_USER_A);
    expect(result.picked).toBe(3);
  });

  it("abstains an opaque gateway row with zero correlated receipts — does not call AI", async () => {
    const txId = await seedUnclassifiedTx({
      userId: TEST_USER_A,
      accountId: accountA,
      externalId: "pipeline-test:opaque-mp",
      descriptionRaw: "MERCADOPAGO COLOMBIA",
    });

    const result = await classifyUnclassifiedBatch(TEST_USER_A, { txIds: [txId] });

    expect(result.picked).toBe(1);
    expect(result.aiClassified).toBe(0);
    expect(result.ruleClassified).toBe(0);
    expect(mockClassifyBatch).not.toHaveBeenCalled();

    const [row] = await db
      .select({
        categorySlug: transactions.categorySlug,
        method: transactions.classificationMethod,
        reason: transactions.classificationReason,
      })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(row?.categorySlug).toBe("otros");
    expect(row?.method).toBe("user_uncategorized");
    expect(row?.reason).toMatchObject({ action: "abstained", reason: "opaque_gateway" });
  });
});

describe("classifyUnclassifiedBatch — merchant knowledge", () => {
  let accountA: number;
  const KB_PREFIX = "pipeline-kb-";

  async function seedHint(userId: number, canonicalMerchant: string, categorySlug: string) {
    await db
      .insert(merchantKnowledge)
      .values({ canonicalMerchant })
      .onConflictDoNothing({ target: merchantKnowledge.canonicalMerchant });
    await db.insert(merchantKnowledgeHints).values({ userId, canonicalMerchant, categorySlug });
  }

  async function cleanupKb() {
    await db.delete(users).where(sql`email LIKE ${KB_PREFIX + "%"}`);
    await db.execute(sql`
      DELETE FROM merchant_knowledge_hints
      WHERE canonical_merchant LIKE ${KB_PREFIX + "%"}
    `);
    await db.delete(merchantKnowledge).where(sql`canonical_merchant LIKE ${KB_PREFIX + "%"}`);
    await cleanupTestTxs();
  }

  beforeEach(async () => {
    await cleanupKb();
    accountA = await defaultAccountId(TEST_USER_A);
    mockClassifyBatch.mockClear();
  });

  afterEach(cleanupKb);

  it("classifies from a KB hint before rules and AI", async () => {
    const merchant = `${KB_PREFIX}${Date.now()}`;
    await seedHint(TEST_USER_A, merchant, "mercado");
    const txId = await seedUnclassifiedTx({
      userId: TEST_USER_A,
      accountId: accountA,
      externalId: `pipeline-test:kb-hit`,
      descriptionRaw: merchant,
      merchant,
      canonicalMerchant: merchant,
    });

    const result = await classifyUnclassifiedBatch(TEST_USER_A, { txIds: [txId] });

    expect(result.merchantKnowledgeClassified).toBe(1);
    expect(result.ruleClassified).toBe(0);
    expect(result.aiClassified).toBe(0);
    expect(mockClassifyBatch).not.toHaveBeenCalled();

    const [row] = await db
      .select({
        categorySlug: transactions.categorySlug,
        method: transactions.classificationMethod,
        reason: transactions.classificationReason,
      })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(row?.categorySlug).toBe("mercado");
    expect(row?.method).toBe("rule_retroactive");
    expect(row?.reason).toMatchObject({ action: "merchant_knowledge", categorySlug: "mercado" });
  });

  it("does not apply another user's hint", async () => {
    const merchant = `${KB_PREFIX}tenant-${Date.now()}`;
    const [other] = await db
      .insert(users)
      .values({ email: `${KB_PREFIX}${Date.now()}@test.local`, name: "kb-other" })
      .returning({ id: users.id });
    await copyCategorySeedsToUser(other.id);
    await seedHint(other.id, merchant, "mercado");
    const txId = await seedUnclassifiedTx({
      userId: TEST_USER_A,
      accountId: accountA,
      externalId: `pipeline-test:kb-tenant`,
      descriptionRaw: merchant,
      merchant,
      canonicalMerchant: merchant,
    });

    mockClassifyBatch.mockResolvedValueOnce({
      classifications: [],
      model: "claude-sonnet-5",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await classifyUnclassifiedBatch(TEST_USER_A, { txIds: [txId] });
    expect(result.merchantKnowledgeClassified).toBe(0);
    expect(mockClassifyBatch).toHaveBeenCalledTimes(1);

    const [row] = await db
      .select({ method: transactions.classificationMethod })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(row?.method).toBe("unclassified");
  });
});
