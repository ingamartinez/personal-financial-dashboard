import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { transactions } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Mock external dependencies — we test the pipeline's DB filtering logic,
// not the AI or rule engine themselves.
// ---------------------------------------------------------------------------

vi.mock("@/lib/classification/ai", () => ({
  classifyBatchWithAi: vi.fn().mockResolvedValue({
    classifications: [],
    model: "claude-haiku-4-5-20251001",
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
}): Promise<number> {
  const [row] = await db.execute<{ id: number }>(sql`
    INSERT INTO transactions (
      user_id, account_id, occurred_at, amount_cents, currency,
      description_raw, classification_method, source, external_id
    ) VALUES (
      ${args.userId}, ${args.accountId}, now(), -10000, 'COP',
      'pipeline-test', 'unclassified'::classification_method,
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
      model: "claude-haiku-4-5-20251001",
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
      model: "claude-haiku-4-5-20251001",
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
      model: "claude-haiku-4-5-20251001",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await classifyUnclassifiedBatch(TEST_USER_A);
    expect(result.picked).toBe(3);
  });
});
