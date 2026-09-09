// Integration tests for the classify-sweep pipeline (#809) — runs against
// findash_test. Only the AI + rule engine are mocked; everything else
// (selection SQL, category creation, settle marker, idempotency) hits real
// Postgres so the WHERE clause and drizzle writes are exercised for real.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, categories, transactions, users } from "@/lib/db/schema";
import { copyCategorySeedsToUser } from "@/lib/auth/signup";

vi.mock("@/lib/classification/rules", () => ({
  classifyByRule: vi.fn().mockResolvedValue(null),
  findMatchingRule: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/classification/ai", () => ({
  classifyBatchWithAi: vi.fn().mockResolvedValue({
    classifications: [],
    model: "claude-haiku-4-5",
    usage: { inputTokens: 0, outputTokens: 0 },
  }),
  // #812: sweep.ts imports this real (unmocked) constant for its own
  // system-category prior-art exclusion — keep it in sync with ai.ts.
  SYSTEM_OWNED_CATEGORY_SLUGS: new Set(["adjustments"]),
}));

const {
  sweepUserOtrosBucket,
  runClassifySweep,
  SWEEP_MIN_CONFIDENCE,
  PRIOR_ART_MIN_AGREEING_ROWS,
} = await import("./sweep");
const { classifyBatchWithAi } = await import("./ai");
const { classifyByRule, findMatchingRule } = await import("./rules");
const mockClassifyBatch = vi.mocked(classifyBatchWithAi);
const mockClassifyByRule = vi.mocked(classifyByRule);
const mockFindMatchingRule = vi.mocked(findMatchingRule);

const TAG = "SWEEP_TEST";

async function createUser(email: string): Promise<number> {
  const [row] = await db.insert(users).values({ email, name: email }).returning({ id: users.id });
  await copyCategorySeedsToUser(row.id);
  return row.id;
}

async function createAccount(userId: number): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({ userId, name: `${TAG} account`, institution: TAG, type: "savings", currency: "COP" })
    .returning({ id: accounts.id });
  return row.id;
}

let seq = 0;
async function insertTx(args: {
  userId: number;
  accountId: number;
  descriptionRaw: string;
  categorySlug: string | null;
  classificationMethod: string;
  channel?: "bank" | "manual" | "transfer" | "cash_withdrawal";
  classificationConfidence?: number;
  amountCents?: number;
  currency?: "COP" | "USD";
  occurredAt?: Date;
}): Promise<number> {
  seq++;
  const [row] = await db.execute<{ id: number }>(sql`
    INSERT INTO transactions (
      user_id, account_id, occurred_at, amount_cents, currency,
      description_raw, category_slug, classification_method,
      classification_confidence, source, external_id, channel
    ) VALUES (
      ${args.userId}, ${args.accountId}, ${(args.occurredAt ?? new Date()).toISOString()},
      ${args.amountCents ?? -10000}, ${args.currency ?? "COP"},
      ${args.descriptionRaw}, ${args.categorySlug},
      ${args.classificationMethod}::classification_method,
      ${args.classificationConfidence ?? null},
      'sms', ${`${TAG}-${seq}`}, ${args.channel ?? "bank"}::tx_channel
    )
    RETURNING id
  `);
  return row.id;
}

async function getTx(id: number) {
  const [row] = await db
    .select({
      categorySlug: transactions.categorySlug,
      classificationMethod: transactions.classificationMethod,
      classificationConfidence: transactions.classificationConfidence,
      classificationReason: transactions.classificationReason,
    })
    .from(transactions)
    .where(eq(transactions.id, id));
  return row;
}

async function cleanup() {
  // ON DELETE CASCADE handles accounts, categories, transactions.
  await db.delete(users).where(sql`email LIKE ${"%" + TAG + "%"}`);
}

describe("sweepUserOtrosBucket", () => {
  let userId: number;
  let accountId: number;

  beforeAll(async () => {
    await cleanup();
  });

  afterEach(async () => {
    mockClassifyBatch.mockClear();
    mockClassifyBatch.mockResolvedValue({
      classifications: [],
      model: "claude-haiku-4-5",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    mockClassifyByRule.mockClear();
    mockClassifyByRule.mockResolvedValue(null);
    mockFindMatchingRule.mockClear();
    mockFindMatchingRule.mockResolvedValue(null);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  async function setup() {
    userId = await createUser(`${TAG}-${Date.now()}-${Math.random()}@test.local`);
    accountId = await createAccount(userId);
  }

  it("never touches channel='transfer' rows", async () => {
    await setup();
    const txId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "Pago TC *1234",
      categorySlug: null,
      classificationMethod: "unclassified",
      channel: "transfer",
    });

    const result = await sweepUserOtrosBucket(userId);

    expect(result.picked).toBe(0);
    expect(mockClassifyBatch).not.toHaveBeenCalled();
    const row = await getTx(txId);
    expect(row?.categorySlug).toBeNull();
    expect(row?.classificationMethod).toBe("unclassified");
  });

  it("never overwrites manual or manual_confirmed decisions", async () => {
    await setup();
    const manualTxId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "manual otros tx",
      categorySlug: "otros",
      classificationMethod: "manual",
    });
    const manualConfirmedTxId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "manual confirmed otros tx",
      categorySlug: "otros",
      classificationMethod: "manual_confirmed",
    });

    const result = await sweepUserOtrosBucket(userId);

    expect(result.picked).toBe(0);
    expect(mockClassifyBatch).not.toHaveBeenCalled();
    expect((await getTx(manualTxId))?.classificationMethod).toBe("manual");
    expect((await getTx(manualConfirmedTxId))?.classificationMethod).toBe("manual_confirmed");
  });

  it("auto-creates a category once the SAME proposal reaches the >=3 threshold with a valid parent", async () => {
    await setup();
    const txIds = await Promise.all(
      [1, 2, 3].map((n) =>
        insertTx({
          userId,
          accountId,
          descriptionRaw: `CLINICA VETERINARIA NORTE ${n}`,
          categorySlug: null,
          classificationMethod: "unclassified",
        }),
      ),
    );

    mockClassifyBatch.mockResolvedValueOnce({
      classifications: txIds.map((id) => ({
        id,
        categorySlug: null,
        confidence: 85,
        reason: "vet clinic",
        proposedCategory: { name: "Mascotas Vet", parentSlug: "vivienda" },
      })),
      model: "claude-haiku-4-5",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await sweepUserOtrosBucket(userId);

    expect(result.categoriesCreated).toHaveLength(1);
    expect(result.categoriesCreated[0]).toMatchObject({
      slug: "mascotas-vet",
      parentSlug: "vivienda",
    });
    expect(result.categoriesCreated[0]?.supportingTxIds.sort()).toEqual([...txIds].sort());

    const [created] = await db
      .select({ slug: categories.slug, parentSlug: categories.parentSlug })
      .from(categories)
      .where(eq(categories.slug, "mascotas-vet"));
    expect(created).toMatchObject({ slug: "mascotas-vet", parentSlug: "vivienda" });

    for (const id of txIds) {
      const row = await getTx(id);
      expect(row?.categorySlug).toBe("mascotas-vet");
      expect(row?.classificationMethod).toBe("ai");
    }
  });

  it("falls back to the existing parent category when the same proposal is BELOW the threshold", async () => {
    await setup();
    const txIds = await Promise.all(
      [1, 2].map((n) =>
        insertTx({
          userId,
          accountId,
          descriptionRaw: `ONE OFF MERCHANT ${n}`,
          categorySlug: null,
          classificationMethod: "unclassified",
        }),
      ),
    );

    mockClassifyBatch.mockResolvedValueOnce({
      classifications: txIds.map((id) => ({
        id,
        categorySlug: null,
        confidence: 85,
        reason: "one-off",
        proposedCategory: { name: "Rare Thing", parentSlug: "vivienda" },
      })),
      model: "claude-haiku-4-5",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await sweepUserOtrosBucket(userId);

    expect(result.categoriesCreated).toHaveLength(0);
    for (const id of txIds) {
      const row = await getTx(id);
      expect(row?.categorySlug).toBe("vivienda");
      expect(row?.classificationMethod).toBe("ai");
    }
  });

  it("never creates a category under a SUBCATEGORY parent — no throw, safe settle fallback (reviewer CRITICAL)", async () => {
    await setup();
    // "restaurantes" is a subcategory of "alimentacion" in the default seed
    // — exactly the shape that used to reach the DB insert and trip
    // categories_enforce_two_levels ("parent % is itself a child").
    const txIds = await Promise.all(
      [1, 2, 3].map((n) =>
        insertTx({
          userId,
          accountId,
          descriptionRaw: `SUBCATEGORY PARENT PROPOSAL ${n}`,
          categorySlug: null,
          classificationMethod: "unclassified",
        }),
      ),
    );

    mockClassifyBatch.mockResolvedValueOnce({
      classifications: txIds.map((id) => ({
        id,
        categorySlug: null,
        confidence: 85,
        reason: "bad nesting",
        proposedCategory: { name: "Bad Nesting", parentSlug: "restaurantes" },
      })),
      model: "claude-haiku-4-5",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    // Must not throw.
    const result = await sweepUserOtrosBucket(userId);

    expect(result.categoriesCreated).toHaveLength(0);
    const [created] = await db
      .select({ slug: categories.slug })
      .from(categories)
      .where(eq(categories.slug, "bad-nesting"));
    expect(created).toBeUndefined();

    // No valid top-level fallback either ("restaurantes" isn't one) — settle.
    expect(result.settledToOtros).toBe(3);
    for (const id of txIds) {
      const row = await getTx(id);
      expect(row?.categorySlug).toBe("otros");
      expect(row?.classificationMethod).toBe("user_uncategorized");
    }
  });

  it("settles to otros with a swept marker when the AI returns no usable signal", async () => {
    await setup();
    const txId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "Retiro ATM oficina",
      categorySlug: null,
      classificationMethod: "unclassified",
      channel: "cash_withdrawal",
    });

    mockClassifyBatch.mockResolvedValueOnce({
      classifications: [{ id: txId, categorySlug: null, confidence: 20 }],
      model: "claude-haiku-4-5",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await sweepUserOtrosBucket(userId);

    expect(result.settledToOtros).toBe(1);
    const row = await getTx(txId);
    expect(row?.categorySlug).toBe("otros");
    expect(row?.classificationMethod).toBe("user_uncategorized");
    expect(row?.classificationReason).toBeTruthy();
    const reason = JSON.parse(row!.classificationReason!);
    expect(reason).toMatchObject({ action: "swept" });
  });

  it("does not apply a real-category AI hit below SWEEP_MIN_CONFIDENCE — settles instead", async () => {
    await setup();
    const txId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "low confidence merchant",
      categorySlug: "otros",
      classificationMethod: "user_uncategorized",
    });

    mockClassifyBatch.mockResolvedValueOnce({
      classifications: [
        { id: txId, categorySlug: "vivienda", confidence: SWEEP_MIN_CONFIDENCE - 1 },
      ],
      model: "claude-haiku-4-5",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await sweepUserOtrosBucket(userId);

    expect(result.settledToOtros).toBe(1);
    expect(result.aiClassified).toBe(0);
    const row = await getTx(txId);
    expect(row?.categorySlug).toBe("otros");
  });

  it("is idempotent: a second consecutive run picks up 0 rows for already-settled transactions", async () => {
    await setup();
    const txId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "unresolvable merchant",
      categorySlug: "otros",
      classificationMethod: "user_uncategorized",
    });

    mockClassifyBatch.mockResolvedValueOnce({
      classifications: [{ id: txId, categorySlug: null, confidence: 10 }],
      model: "claude-haiku-4-5",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const first = await sweepUserOtrosBucket(userId);
    expect(first.picked).toBe(1);
    expect(first.settledToOtros).toBe(1);

    mockClassifyBatch.mockClear();
    const second = await sweepUserOtrosBucket(userId);

    expect(second.picked).toBe(0);
    expect(second.settledToOtros).toBe(0);
    expect(second.aiClassified).toBe(0);
    expect(second.ruleClassified).toBe(0);
    expect(mockClassifyBatch).not.toHaveBeenCalled();
  });

  it("dryRun mode computes the full plan but writes nothing", async () => {
    await setup();
    const txId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "dry run merchant",
      categorySlug: null,
      classificationMethod: "unclassified",
    });

    mockClassifyBatch.mockResolvedValueOnce({
      classifications: [{ id: txId, categorySlug: "vivienda", confidence: 90, reason: "test" }],
      model: "claude-haiku-4-5",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await sweepUserOtrosBucket(userId, { dryRun: true });

    expect(result.aiClassified).toBe(1);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      txId,
      before: { categorySlug: null, classificationMethod: "unclassified" },
      after: { categorySlug: "vivienda", classificationMethod: "ai" },
    });

    // Nothing was actually written.
    const row = await getTx(txId);
    expect(row?.categorySlug).toBeNull();
    expect(row?.classificationMethod).toBe("unclassified");
  });
});

describe("sweepUserOtrosBucket — prior art", () => {
  let userId: number;
  let accountId: number;

  beforeAll(async () => {
    await cleanup();
  });

  afterEach(async () => {
    mockClassifyBatch.mockClear();
    mockClassifyBatch.mockResolvedValue({
      classifications: [],
      model: "claude-haiku-4-5",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    mockClassifyByRule.mockClear();
    mockClassifyByRule.mockResolvedValue(null);
    mockFindMatchingRule.mockClear();
    mockFindMatchingRule.mockResolvedValue(null);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  async function setup() {
    userId = await createUser(`${TAG}-pa-${Date.now()}-${Math.random()}@test.local`);
    accountId = await createAccount(userId);
  }

  it("wins over a conflicting seed rule (#809 review: IMPTO GOBIERNO 4X1000 case)", async () => {
    await setup();
    // The user manually filed this exact merchant under `vivienda` once
    // before — a stand-in for a user-created category like the real `4x100`.
    await insertTx({
      userId,
      accountId,
      descriptionRaw: "IMPTO GOBIERNO 4X1000",
      categorySlug: "vivienda",
      classificationMethod: "manual",
    });
    const txId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "IMPTO GOBIERNO 4X1000",
      categorySlug: null,
      classificationMethod: "unclassified",
    });

    // Simulate a seed rule that would route this merchant somewhere else —
    // prior art must win before the rule engine is even consulted.
    mockClassifyByRule.mockResolvedValue({
      categorySlug: "comisiones-bancarias",
      ruleId: 999,
      confidence: 100,
    });

    const result = await sweepUserOtrosBucket(userId);

    expect(mockClassifyByRule).not.toHaveBeenCalled();
    expect(mockClassifyBatch).not.toHaveBeenCalled();
    expect(result.priorArtClassified).toBe(1);
    expect(result.ruleClassified).toBe(0);

    const row = await getTx(txId);
    expect(row?.categorySlug).toBe("vivienda");
    expect(row?.classificationMethod).toBe("rule_retroactive");
    expect(row?.classificationConfidence).toBe(100);
    const reason = JSON.parse(row!.classificationReason!);
    expect(reason).toMatchObject({ action: "prior_art", categorySlug: "vivienda" });
  });

  it("manual/manual_confirmed outranks a larger rule/ai count for a different category", async () => {
    await setup();
    // 3 weak (rule) rows agreeing on "gasolina" — would win on count alone...
    for (let i = 0; i < 3; i++) {
      await insertTx({
        userId,
        accountId,
        descriptionRaw: "GASOLINERA XYZ",
        categorySlug: "gasolina",
        classificationMethod: "rule",
      });
    }
    // ...but a single manual_confirmed row disagreeing must still win.
    await insertTx({
      userId,
      accountId,
      descriptionRaw: "GASOLINERA XYZ",
      categorySlug: "vivienda",
      classificationMethod: "manual_confirmed",
    });
    const txId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "GASOLINERA XYZ",
      categorySlug: null,
      classificationMethod: "unclassified",
    });

    const result = await sweepUserOtrosBucket(userId);

    expect(result.priorArtClassified).toBe(1);
    const row = await getTx(txId);
    expect(row?.categorySlug).toBe("vivienda");
    expect(row?.classificationMethod).toBe("rule_retroactive");
  });

  it(`requires >= ${PRIOR_ART_MIN_AGREEING_ROWS} agreeing non-manual rows — 1 is not enough`, async () => {
    await setup();
    await insertTx({
      userId,
      accountId,
      descriptionRaw: "LONE MERCHANT ROW",
      categorySlug: "vivienda",
      classificationMethod: "ai",
    });
    const txId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "LONE MERCHANT ROW",
      categorySlug: null,
      classificationMethod: "unclassified",
    });

    // Falls through to the rule engine, which we control here.
    mockClassifyByRule.mockResolvedValue({
      categorySlug: "gasolina",
      ruleId: 1,
      confidence: 100,
    });

    const result = await sweepUserOtrosBucket(userId);

    expect(result.priorArtClassified).toBe(0);
    expect(mockClassifyByRule).toHaveBeenCalled();
    const row = await getTx(txId);
    expect(row?.categorySlug).toBe("gasolina");
    expect(row?.classificationMethod).toBe("rule");
  });

  it(`wins once >= ${PRIOR_ART_MIN_AGREEING_ROWS} non-manual rows agree`, async () => {
    await setup();
    for (let i = 0; i < PRIOR_ART_MIN_AGREEING_ROWS; i++) {
      await insertTx({
        userId,
        accountId,
        descriptionRaw: "TWO ROW MERCHANT",
        categorySlug: "vivienda",
        classificationMethod: "ai",
      });
    }
    const txId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "TWO ROW MERCHANT",
      categorySlug: null,
      classificationMethod: "unclassified",
    });

    const result = await sweepUserOtrosBucket(userId);

    expect(result.priorArtClassified).toBe(1);
    expect(mockClassifyByRule).not.toHaveBeenCalled();
    const row = await getTx(txId);
    expect(row?.categorySlug).toBe("vivienda");
    expect(row?.classificationMethod).toBe("rule_retroactive");
    expect(row?.classificationConfidence).toBe(90); // weak evidence, not manual
  });

  it("falls through to rule/AI on ambiguous evidence (two categories each with manual rows)", async () => {
    await setup();
    await insertTx({
      userId,
      accountId,
      descriptionRaw: "CONTRADICTORY MERCHANT",
      categorySlug: "vivienda",
      classificationMethod: "manual",
    });
    await insertTx({
      userId,
      accountId,
      descriptionRaw: "CONTRADICTORY MERCHANT",
      categorySlug: "gasolina",
      classificationMethod: "manual",
    });
    const txId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "CONTRADICTORY MERCHANT",
      categorySlug: null,
      classificationMethod: "unclassified",
    });

    mockClassifyByRule.mockResolvedValue({
      categorySlug: "suscripciones",
      ruleId: 1,
      confidence: 100,
    });

    const result = await sweepUserOtrosBucket(userId);

    expect(result.priorArtClassified).toBe(0);
    expect(mockClassifyByRule).toHaveBeenCalled();
    const row = await getTx(txId);
    expect(row?.categorySlug).toBe("suscripciones");
    expect(row?.classificationMethod).toBe("rule");
  });

  it("excludes system-owned categories (adjustments) from prior-art evidence (#812)", async () => {
    await setup();
    // A manual row filed under the system-owned "adjustments" category would
    // normally win prior art outright (a single manual row is enough) — but
    // "adjustments" is a reconciliation plug, not a classification decision,
    // and must never resurface as evidence for an unrelated merchant.
    await insertTx({
      userId,
      accountId,
      descriptionRaw: "PLUG AJUSTE MERCHANT",
      categorySlug: "adjustments",
      classificationMethod: "manual",
    });
    const txId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "PLUG AJUSTE MERCHANT",
      categorySlug: null,
      classificationMethod: "unclassified",
    });

    mockClassifyByRule.mockResolvedValue({
      categorySlug: "otros",
      ruleId: 1,
      confidence: 100,
    });

    const result = await sweepUserOtrosBucket(userId);

    expect(result.priorArtClassified).toBe(0);
    expect(mockClassifyByRule).toHaveBeenCalled();
    const row = await getTx(txId);
    expect(row?.categorySlug).toBe("otros");
    expect(row?.classificationMethod).toBe("rule");
  });

  it("tenant scoping: another user's history never leaks in (#336/#338)", async () => {
    // User A has a confident manual decision for this merchant...
    const userA = await createUser(`${TAG}-pa-tenant-a-${Date.now()}-${Math.random()}@test.local`);
    const accountA = await createAccount(userA);
    await insertTx({
      userId: userA,
      accountId: accountA,
      descriptionRaw: "SHARED MERCHANT NAME",
      categorySlug: "vivienda",
      classificationMethod: "manual",
    });

    // ...but user B (the one being swept) must not see it.
    await setup();
    const txId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "SHARED MERCHANT NAME",
      categorySlug: null,
      classificationMethod: "unclassified",
    });

    mockClassifyByRule.mockResolvedValue({
      categorySlug: "gasolina",
      ruleId: 1,
      confidence: 100,
    });

    const result = await sweepUserOtrosBucket(userId);

    expect(result.priorArtClassified).toBe(0);
    const row = await getTx(txId);
    expect(row?.categorySlug).toBe("gasolina");
    expect(row?.classificationMethod).toBe("rule");

    await db.delete(users).where(eq(users.id, userA));
  });
});

describe("sweepUserOtrosBucket — abstain (#812)", () => {
  let userId: number;
  let accountId: number;

  beforeAll(async () => {
    await cleanup();
  });

  afterEach(async () => {
    mockClassifyBatch.mockClear();
    mockClassifyBatch.mockResolvedValue({
      classifications: [],
      model: "claude-haiku-4-5",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    mockClassifyByRule.mockClear();
    mockClassifyByRule.mockResolvedValue(null);
    mockFindMatchingRule.mockClear();
    mockFindMatchingRule.mockResolvedValue(null);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  async function setup() {
    userId = await createUser(`${TAG}-abstain-${Date.now()}-${Math.random()}@test.local`);
    accountId = await createAccount(userId);
  }

  it("abstains an opaque gateway row — never calls rule engine or AI", async () => {
    await setup();
    const txId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "MERCADOPAGO COLOMBIA",
      categorySlug: null,
      classificationMethod: "unclassified",
    });

    const result = await sweepUserOtrosBucket(userId);

    expect(result.abstainedGateway).toBe(1);
    expect(result.priorArtClassified).toBe(0);
    expect(result.ruleClassified).toBe(0);
    expect(result.aiClassified).toBe(0);
    expect(mockFindMatchingRule).not.toHaveBeenCalled();
    expect(mockClassifyByRule).not.toHaveBeenCalled();
    expect(mockClassifyBatch).not.toHaveBeenCalled();

    const row = await getTx(txId);
    expect(row?.categorySlug).toBe("otros");
    expect(row?.classificationMethod).toBe("user_uncategorized");
    expect(row?.classificationConfidence).toBe(0);
    const reason = JSON.parse(row!.classificationReason!);
    expect(reason).toMatchObject({
      action: "abstained",
      reason: "opaque_gateway",
      gateway: "mercado_pago",
    });
  });

  it("does NOT abstain a real merchant that merely transacts through a gateway (#812 negative case)", async () => {
    await setup();
    const txId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "AMAZON MKTPLACE PMTS",
      categorySlug: null,
      classificationMethod: "unclassified",
    });

    mockClassifyBatch.mockResolvedValueOnce({
      classifications: [{ id: txId, categorySlug: "vivienda", confidence: 90, reason: "amazon" }],
      model: "claude-haiku-4-5",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await sweepUserOtrosBucket(userId);

    expect(result.abstainedGateway).toBe(0);
    expect(result.aiClassified).toBe(1);
    expect(mockClassifyBatch).toHaveBeenCalled();
  });

  it("gateway abstain OUTRANKS prior art — a poisoned prior decision must not resurface", async () => {
    await setup();
    // Two prior AI-classified rows agreeing on "tecnologia" for the exact
    // same opaque description — enough to win prior art (>= 2 agreeing rows)
    // if the abstain check did not run first.
    for (let i = 0; i < 2; i++) {
      await insertTx({
        userId,
        accountId,
        descriptionRaw: "MERCADOPAGO COLOMBIA",
        categorySlug: "tecnologia",
        classificationMethod: "ai",
      });
    }
    const txId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "MERCADOPAGO COLOMBIA",
      categorySlug: null,
      classificationMethod: "unclassified",
    });

    const result = await sweepUserOtrosBucket(userId);

    expect(result.abstainedGateway).toBe(1);
    expect(result.priorArtClassified).toBe(0);
    const row = await getTx(txId);
    expect(row?.categorySlug).toBe("otros");
    expect(row?.classificationMethod).toBe("user_uncategorized");
  });

  it("abstains both legs of a probable same-account unpaired transfer pair", async () => {
    await setup();
    const sameDate = new Date("2026-01-28T12:00:00Z");
    const txA = await insertTx({
      userId,
      accountId,
      descriptionRaw: "ABONO AMPLIACION DE PLAZO",
      categorySlug: null,
      classificationMethod: "unclassified",
      amountCents: 217_937_00,
      currency: "USD",
      occurredAt: sameDate,
    });
    const txB = await insertTx({
      userId,
      accountId,
      descriptionRaw: "AMPLIACION DE PLAZO",
      categorySlug: null,
      classificationMethod: "unclassified",
      amountCents: -217_937_00,
      currency: "USD",
      occurredAt: sameDate,
    });

    const result = await sweepUserOtrosBucket(userId);

    expect(result.abstainedTransferPair).toBe(2);
    expect(mockClassifyBatch).not.toHaveBeenCalled();

    for (const id of [txA, txB]) {
      const row = await getTx(id);
      expect(row?.categorySlug).toBe("otros");
      expect(row?.classificationMethod).toBe("user_uncategorized");
      const reason = JSON.parse(row!.classificationReason!);
      expect(reason).toMatchObject({ action: "abstained", reason: "probable_transfer_pair" });
    }
  });

  it("does NOT flag a different-account opposite-amount pair as a transfer candidate", async () => {
    await setup();
    const otherAccountId = await createAccount(userId);
    const sameDate = new Date("2026-02-05T12:00:00Z");
    const txId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "SOME BANK LINE",
      categorySlug: null,
      classificationMethod: "unclassified",
      amountCents: -50000,
      occurredAt: sameDate,
    });
    await insertTx({
      userId,
      accountId: otherAccountId,
      descriptionRaw: "OTHER ACCOUNT OPPOSITE AMOUNT",
      categorySlug: null,
      classificationMethod: "unclassified",
      amountCents: 50000,
      occurredAt: sameDate,
    });

    mockClassifyBatch.mockResolvedValue({
      classifications: [],
      model: "claude-haiku-4-5",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await sweepUserOtrosBucket(userId);

    expect(result.abstainedTransferPair).toBe(0);
    const row = await getTx(txId);
    expect(row?.categorySlug).toBe("otros");
    expect(row?.classificationMethod).toBe("user_uncategorized");
    const reason = JSON.parse(row!.classificationReason!);
    expect(reason).toMatchObject({ action: "swept" });
  });

  it("abstained rows are excluded from fetchPriorArtIndex for a LATER run (never become prior-art evidence)", async () => {
    await setup();
    // First run: abstain the gateway row.
    await insertTx({
      userId,
      accountId,
      descriptionRaw: "MERCADOPAGO COLOMBIA",
      categorySlug: null,
      classificationMethod: "unclassified",
    });
    const firstRun = await sweepUserOtrosBucket(userId);
    expect(firstRun.abstainedGateway).toBe(1);

    // A second, unrelated MercadoPago row arrives later — if the abstained
    // row above had leaked into prior art (it settled to category_slug=
    // 'otros', which fetchPriorArtIndex already excludes), this would
    // wrongly resolve via prior art instead of abstaining again.
    const txId2 = await insertTx({
      userId,
      accountId,
      descriptionRaw: "MERCADOPAGO COLOMBIA",
      categorySlug: null,
      classificationMethod: "unclassified",
    });

    const secondRun = await sweepUserOtrosBucket(userId);

    expect(secondRun.priorArtClassified).toBe(0);
    expect(secondRun.abstainedGateway).toBe(1);
    const row = await getTx(txId2);
    expect(row?.categorySlug).toBe("otros");
    const reason = JSON.parse(row!.classificationReason!);
    expect(reason).toMatchObject({ action: "abstained", reason: "opaque_gateway" });
  });

  it("is idempotent: a second run does not re-touch an already-abstained row", async () => {
    await setup();
    const txId = await insertTx({
      userId,
      accountId,
      descriptionRaw: "WOMPI*TIENDA123",
      categorySlug: null,
      classificationMethod: "unclassified",
    });

    const first = await sweepUserOtrosBucket(userId);
    expect(first.abstainedGateway).toBe(1);

    mockClassifyBatch.mockClear();
    const second = await sweepUserOtrosBucket(userId);

    expect(second.picked).toBe(0);
    expect(second.abstainedGateway).toBe(0);
    expect(mockClassifyBatch).not.toHaveBeenCalled();

    const row = await getTx(txId);
    expect(row?.categorySlug).toBe("otros");
  });
});

describe("runClassifySweep — per-user failure isolation", () => {
  afterEach(async () => {
    mockClassifyBatch.mockClear();
    mockClassifyBatch.mockResolvedValue({
      classifications: [],
      model: "claude-haiku-4-5",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    mockClassifyByRule.mockClear();
    mockClassifyByRule.mockResolvedValue(null);
    await cleanup();
  });

  it("one user's throw does not abort the run — the other user still gets swept, failure is reported", async () => {
    const userA = await createUser(`${TAG}-iso-a-${Date.now()}-${Math.random()}@test.local`);
    const accountA = await createAccount(userA);
    await insertTx({
      userId: userA,
      accountId: accountA,
      descriptionRaw: "WILL THROW",
      categorySlug: null,
      classificationMethod: "unclassified",
    });

    const userB = await createUser(`${TAG}-iso-b-${Date.now()}-${Math.random()}@test.local`);
    const accountB = await createAccount(userB);
    await insertTx({
      userId: userB,
      accountId: accountB,
      descriptionRaw: "WILL SUCCEED",
      categorySlug: null,
      classificationMethod: "unclassified",
    });

    // Whichever user is processed first hits the AI call and throws; the
    // other's AI call resolves cleanly. Order across the two users is not
    // guaranteed (no ORDER BY on the active-users query), so the assertions
    // below are deliberately order-agnostic.
    mockClassifyBatch.mockRejectedValueOnce(new Error("boom"));
    mockClassifyBatch.mockResolvedValueOnce({
      classifications: [],
      model: "claude-haiku-4-5",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await runClassifySweep({ userIds: [userA, userB] });

    expect(result.usersProcessed).toBe(1);
    expect(result.failedUserIds).toHaveLength(1);
    expect([userA, userB]).toContain(result.failedUserIds[0]);
    expect(result.perUser).toHaveLength(1);
  });
});
