import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  categories,
  categorySeeds,
  classificationRuleSeeds,
  classificationRules,
  users,
} from "@/lib/db/schema";
import { copyCategorySeedsToUser, copyRuleSeedsToUser } from "./signup";

// Integration test for the signup → categories + rules copy flow.
//
// Order matters: copyCategorySeedsToUser MUST run before copyRuleSeedsToUser
// because classification_rules has a composite FK on (user_id, category_slug)
// → categories(user_id, slug). The test asserts that ordering and the
// idempotency guarantees of both hooks.

const EMAIL_PREFIX = "signup-test-";

async function cleanup() {
  await db.delete(users).where(sql`email LIKE ${EMAIL_PREFIX + "%"}`);
}

async function createTestUser(tag: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email: `${EMAIL_PREFIX}${tag}@test.local`, name: tag })
    .returning({ id: users.id });
  return row.id;
}

describe("copyCategorySeedsToUser", () => {
  let seedCount = 0;

  beforeAll(async () => {
    await cleanup();
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(categorySeeds);
    seedCount = row.n;
    expect(seedCount).toBeGreaterThan(0);
  });

  afterEach(cleanup);

  it("copies every category seed into categories with user_id set", async () => {
    const userId = await createTestUser("cat-basic");
    const inserted = await copyCategorySeedsToUser(userId);
    expect(inserted).toBe(seedCount);

    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(categories)
      .where(eq(categories.userId, userId));
    expect(row.n).toBe(seedCount);
  });

  it("is idempotent — second call returns 0 and row count is stable", async () => {
    const userId = await createTestUser("cat-idempotent");
    const first = await copyCategorySeedsToUser(userId);
    expect(first).toBe(seedCount);

    const second = await copyCategorySeedsToUser(userId);
    expect(second).toBe(0);

    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(categories)
      .where(eq(categories.userId, userId));
    expect(row.n).toBe(seedCount);
  });

  it("preserves parent_slug relationships per user", async () => {
    const userId = await createTestUser("cat-parent");
    await copyCategorySeedsToUser(userId);

    // `mercado` is defined in the seed with parent_slug='alimentacion'.
    const [row] = await db
      .select({ parentSlug: categories.parentSlug })
      .from(categories)
      .where(and(eq(categories.userId, userId), eq(categories.slug, "mercado")));
    expect(row.parentSlug).toBe("alimentacion");
  });
});

describe("copyRuleSeedsToUser", () => {
  let ruleSeedCount = 0;

  beforeAll(async () => {
    await cleanup();
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(classificationRuleSeeds);
    ruleSeedCount = row.n;
    expect(ruleSeedCount).toBeGreaterThan(0);
  });

  afterEach(cleanup);
  afterAll(async () => {
    await db.$client.end({ timeout: 1 });
  });

  it("copies every seed into classification_rules with user_id set", async () => {
    const userId = await createTestUser("rule-basic");
    // Categories must be materialized first — rules FK composite against them.
    await copyCategorySeedsToUser(userId);
    const inserted = await copyRuleSeedsToUser(userId);
    expect(inserted).toBe(ruleSeedCount);

    const rules = await db
      .select({ pattern: classificationRules.pattern })
      .from(classificationRules)
      .where(eq(classificationRules.userId, userId));
    expect(rules).toHaveLength(ruleSeedCount);
  });

  it("is idempotent — second call returns 0 and row count is stable", async () => {
    const userId = await createTestUser("rule-idempotent");
    await copyCategorySeedsToUser(userId);
    const first = await copyRuleSeedsToUser(userId);
    expect(first).toBe(ruleSeedCount);

    const second = await copyRuleSeedsToUser(userId);
    expect(second).toBe(0);

    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(classificationRules)
      .where(eq(classificationRules.userId, userId));
    expect(row.n).toBe(ruleSeedCount);
  });

  it("tops up a partial rule set", async () => {
    const userId = await createTestUser("rule-partial");
    await copyCategorySeedsToUser(userId);
    await copyRuleSeedsToUser(userId);

    const [anyRule] = await db
      .select({
        id: classificationRules.id,
        pattern: classificationRules.pattern,
        categorySlug: classificationRules.categorySlug,
      })
      .from(classificationRules)
      .where(eq(classificationRules.userId, userId))
      .limit(1);

    await db
      .delete(classificationRules)
      .where(and(eq(classificationRules.userId, userId), eq(classificationRules.id, anyRule.id)));

    const topUp = await copyRuleSeedsToUser(userId);
    expect(topUp).toBe(1);

    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(classificationRules)
      .where(eq(classificationRules.userId, userId));
    expect(row.n).toBe(ruleSeedCount);
  });

  it("keeps users isolated — copying for userB does not affect userA", async () => {
    const userA = await createTestUser("rule-iso-a");
    const userB = await createTestUser("rule-iso-b");

    await copyCategorySeedsToUser(userA);
    await copyCategorySeedsToUser(userB);
    await copyRuleSeedsToUser(userA);
    await copyRuleSeedsToUser(userB);

    const [countA] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(classificationRules)
      .where(eq(classificationRules.userId, userA));
    const [countB] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(classificationRules)
      .where(eq(classificationRules.userId, userB));

    expect(countA.n).toBe(ruleSeedCount);
    expect(countB.n).toBe(ruleSeedCount);
  });
});
