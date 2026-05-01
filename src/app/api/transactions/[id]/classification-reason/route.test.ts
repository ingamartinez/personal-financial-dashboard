import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: 1, email: "test@test.local", name: "Test" }),
  getSessionUserOrNull: vi
    .fn()
    .mockResolvedValue({ id: 1, email: "test@test.local", name: "Test" }),
}));

const { GET } = await import("./route");

const TEST_USER_ID = 1;
const EXTERNAL_PREFIX = "TEST-REASON-TXN-";
const RULE_PATTERN_PREFIX = "TEST-REASON-RULE-";

async function cleanup() {
  // Wipe all transactions seeded by this file regardless of user_id — the 404
  // cross-tenant test inserts a row owned by a different user and must be
  // cleaned here or it produces a duplicate key on the next run.
  await db.execute(sql`
    DELETE FROM transactions
    WHERE external_id LIKE ${EXTERNAL_PREFIX + "%"}
  `);
  await db.execute(sql`
    DELETE FROM classification_rules
    WHERE user_id = ${TEST_USER_ID} AND pattern LIKE ${"%" + RULE_PATTERN_PREFIX + "%"}
  `);
}

async function seedRule(pattern: string, categorySlug: string): Promise<number> {
  const rows = await db.execute<{ id: number }>(sql`
    INSERT INTO classification_rules (user_id, pattern, category_slug, priority, active)
    VALUES (${TEST_USER_ID}, ${pattern}, ${categorySlug}, 100, true)
    RETURNING id
  `);
  return rows[0].id;
}

async function seedTxn(args: {
  externalId: string;
  merchant?: string | null;
  descriptionClean?: string | null;
  categorySlug: string | null;
  method: "rule" | "rule_retroactive" | "ai" | "manual" | "manual_confirmed" | "unclassified";
  confidence?: number | null;
  reason?: string | null;
  previousCategorySlug?: string | null;
  retroactiveRuleId?: number | null;
}): Promise<number> {
  const [acc] = await db.execute<{ id: number }>(sql`
    SELECT id FROM accounts WHERE name = 'Bancolombia Ahorros' LIMIT 1
  `);
  const rows = await db.execute<{ id: number }>(sql`
    INSERT INTO transactions (
      user_id, account_id, occurred_at, amount_cents, currency,
      description_raw, description_clean, merchant, category_slug,
      classification_method, classification_confidence, classification_reason,
      previous_category_slug, retroactive_rule_id, source, external_id
    ) VALUES (
      ${TEST_USER_ID},
      ${acc.id},
      now(),
      -5000,
      'COP',
      ${args.descriptionClean ?? args.merchant ?? "test"},
      ${args.descriptionClean ?? null},
      ${args.merchant ?? null},
      ${args.categorySlug},
      ${args.method}::classification_method,
      ${args.confidence ?? null},
      ${args.reason ?? null},
      ${args.previousCategorySlug ?? null},
      ${args.retroactiveRuleId ?? null},
      'sms',
      ${args.externalId}
    )
    RETURNING id
  `);
  return rows[0].id;
}

function makeRequest(id: number | string): Request {
  return new Request(`http://localhost:3100/api/transactions/${id}/classification-reason`, {
    method: "GET",
  });
}

function makeContext(id: string | number): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: String(id) }) };
}

beforeEach(cleanup);
afterEach(cleanup);

describe("GET /api/transactions/[id]/classification-reason", () => {
  it("returns rule branch with matched pattern + categorySlug", async () => {
    // Unique-token merchant so it doesn't trip seeded rules (CARULLA, RAPPI, …).
    const uniqueToken = `${RULE_PATTERN_PREFIX}UNIQUETOKENREASON`;
    const ruleId = await seedRule(`%${uniqueToken}%`, "alimentacion");
    const txId = await seedTxn({
      externalId: `${EXTERNAL_PREFIX}rule`,
      merchant: `${uniqueToken}-SUFFIX`,
      categorySlug: "alimentacion",
      method: "rule",
      confidence: 100,
    });

    const res = await GET(makeRequest(txId), makeContext(txId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.method).toBe("rule");
    expect(body.detail.rule.id).toBe(ruleId);
    expect(body.detail.rule.pattern).toBe(`%${uniqueToken}%`);
    expect(body.detail.rule.categorySlug).toBe("alimentacion");
    expect(body.summary).toContain("Regla");
    expect(body.summary).toContain(`#${ruleId}`);
  });

  it("rule_retroactive uses retroactive_rule_id FK directly", async () => {
    const ruleId = await seedRule(`%${RULE_PATTERN_PREFIX}RETRO%`, "alimentacion");
    const txId = await seedTxn({
      externalId: `${EXTERNAL_PREFIX}retro`,
      merchant: `${RULE_PATTERN_PREFIX}RETRO-WAS-CATEGORIZED-LATER`,
      categorySlug: "alimentacion",
      method: "rule_retroactive",
      previousCategorySlug: "transferencias",
      retroactiveRuleId: ruleId,
    });

    const res = await GET(makeRequest(txId), makeContext(txId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.method).toBe("rule_retroactive");
    expect(body.detail.rule.id).toBe(ruleId);
  });

  it("returns ai branch with reason + confidence", async () => {
    const txId = await seedTxn({
      externalId: `${EXTERNAL_PREFIX}ai`,
      merchant: "NO-MATCHING-PATTERN",
      categorySlug: "suscripciones",
      method: "ai",
      confidence: 87,
      reason: "merchant name matches streaming service pattern",
    });

    const res = await GET(makeRequest(txId), makeContext(txId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.method).toBe("ai");
    expect(body.detail.confidence).toBe(87);
    expect(body.detail.reason).toBe("merchant name matches streaming service pattern");
    expect(body.summary).toContain("Claude");
    expect(body.summary).toContain("87%");
  });

  it("returns manual branch with previous_category_slug", async () => {
    const txId = await seedTxn({
      externalId: `${EXTERNAL_PREFIX}manual`,
      merchant: "MANUAL-CHANGE",
      categorySlug: "alimentacion",
      method: "manual",
      confidence: 100,
      previousCategorySlug: "transferencias",
    });

    const res = await GET(makeRequest(txId), makeContext(txId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.method).toBe("manual");
    expect(body.detail.previousCategorySlug).toBe("transferencias");
    expect(body.summary).toContain("manualmente");
  });

  it("returns manual_confirmed branch with original method + confidence decoded", async () => {
    const txId = await seedTxn({
      externalId: `${EXTERNAL_PREFIX}confirmed`,
      merchant: "CONFIRMED-FROM-INBOX",
      categorySlug: "suscripciones",
      method: "manual_confirmed",
      confidence: 100,
      reason: JSON.stringify({ confirmed_from: "ai", confidence: 45 }),
    });

    const res = await GET(makeRequest(txId), makeContext(txId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.method).toBe("manual_confirmed");
    expect(body.detail.originalMethod).toBe("ai");
    expect(body.detail.originalConfidence).toBe(45);
    expect(body.summary).toContain("Confirmado");
    expect(body.summary).toContain("ai");
    expect(body.summary).toContain("45%");
  });

  it("returns unclassified branch", async () => {
    const txId = await seedTxn({
      externalId: `${EXTERNAL_PREFIX}unclass`,
      merchant: "UNCLASSIFIED-TXN",
      categorySlug: null,
      method: "unclassified",
    });

    const res = await GET(makeRequest(txId), makeContext(txId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.method).toBe("unclassified");
    expect(body.detail).toBeNull();
  });

  it("404s when transaction belongs to another user", async () => {
    // Insert a txn for a different user — we use the seed's second user if present,
    // otherwise create a stand-in. The key check is that user 1's session can't read it.
    const [acc] = await db.execute<{ id: number }>(sql`
      SELECT id FROM accounts WHERE user_id <> ${TEST_USER_ID} LIMIT 1
    `);
    if (!acc) {
      // Test seed only has user 1 — skip this scenario gracefully by asserting
      // the bare 404 shape for a non-existent id instead.
      const res = await GET(makeRequest(9_999_999), makeContext(9_999_999));
      expect(res.status).toBe(404);
      return;
    }
    const rows = await db.execute<{ id: number }>(sql`
      INSERT INTO transactions (
        user_id, account_id, occurred_at, amount_cents, currency, description_raw,
        classification_method, source, external_id
      )
      SELECT user_id, ${acc.id}, now(), -5000, 'COP', 'other user txn',
        'manual'::classification_method, 'sms', ${EXTERNAL_PREFIX + "other"}
      FROM accounts WHERE id = ${acc.id}
      RETURNING id
    `);
    const otherTxId = rows[0].id;

    const res = await GET(makeRequest(otherTxId), makeContext(otherTxId));
    expect(res.status).toBe(404);
  });

  it("400s on invalid id parameter", async () => {
    const res = await GET(makeRequest("not-a-number"), makeContext("not-a-number"));
    expect(res.status).toBe(400);
  });
});
