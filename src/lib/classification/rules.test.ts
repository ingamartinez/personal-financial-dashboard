import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { classifyByRule } from "./rules";

const TAG = "VITEST_RULES_";
const TEST_USER_ID = 1;

async function clearTestRules() {
  await db.execute(sql`DELETE FROM classification_rules WHERE pattern LIKE ${"%" + TAG + "%"}`);
}

async function insertRule(pattern: string, categorySlug: string, priority: number) {
  const rows = await db.execute<{ id: number }>(sql`
    INSERT INTO classification_rules (user_id, pattern, category_slug, priority, active)
    VALUES (${TEST_USER_ID}, ${pattern}, ${categorySlug}, ${priority}, true)
    RETURNING id
  `);
  return rows[0].id;
}

async function getHitCount(id: number) {
  const rows = await db.execute<{ hit_count: number }>(sql`
    SELECT hit_count FROM classification_rules WHERE id = ${id}
  `);
  return rows[0].hit_count;
}

describe("classifyByRule", () => {
  beforeAll(clearTestRules);
  afterEach(clearTestRules);
  afterAll(async () => {
    await db.$client.end({ timeout: 1 });
  });

  it("returns null when no rule matches", async () => {
    await insertRule(`%${TAG}NOMATCH%`, "otros", 10);
    const result = await classifyByRule(TEST_USER_ID, {
      descriptionRaw: "completely unrelated text",
    });
    expect(result).toBeNull();
  });

  it("matches by ILIKE on description", async () => {
    const id = await insertRule(`%${TAG}MATCH%`, "mercado", 1);
    const result = await classifyByRule(TEST_USER_ID, {
      descriptionRaw: `compra ${TAG}match chia 12345`,
    });
    expect(result).toEqual({ categorySlug: "mercado", ruleId: id, confidence: 100 });
  });

  it("respects priority (lower wins) when multiple rules match", async () => {
    const lowPri = await insertRule(`%${TAG}AMBIG%`, "mercado", 5);
    await insertRule(`%${TAG}AMBIG%`, "delivery", 50);
    const result = await classifyByRule(TEST_USER_ID, {
      descriptionRaw: `${TAG}AMBIG payment`,
    });
    expect(result?.ruleId).toBe(lowPri);
    expect(result?.categorySlug).toBe("mercado");
  });

  it("increments hit_count and sets last_hit_at on match", async () => {
    const id = await insertRule(`%${TAG}HITS%`, "otros", 10);
    expect(await getHitCount(id)).toBe(0);

    await classifyByRule(TEST_USER_ID, { descriptionRaw: `${TAG}HITS one` });
    await classifyByRule(TEST_USER_ID, { descriptionRaw: `${TAG}HITS two` });

    expect(await getHitCount(id)).toBe(2);

    const rows = await db.execute<{ last_hit_at: Date | null }>(sql`
      SELECT last_hit_at FROM classification_rules WHERE id = ${id}
    `);
    expect(rows[0].last_hit_at).not.toBeNull();
  });

  it("ignores inactive rules", async () => {
    const id = await insertRule(`%${TAG}INACTIVE%`, "otros", 10);
    await db.execute(sql`UPDATE classification_rules SET active = false WHERE id = ${id}`);
    const result = await classifyByRule(TEST_USER_ID, { descriptionRaw: `${TAG}INACTIVE thing` });
    expect(result).toBeNull();
  });
});
