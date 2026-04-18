import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { classificationRuleSeeds, classificationRules, users } from "@/lib/db/schema";
import { copyRuleSeedsToUser } from "./signup";

// Integration test for the signup → rules copy flow (PR 4 of #183).
// Creates an isolated user, copies the seeds, and verifies:
//   - every seed row became a classification_rules row with user_id set
//   - the call is idempotent (ON CONFLICT on the (user_id, pattern, category_slug)
//     unique constraint swallows reruns)

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

describe("copyRuleSeedsToUser", () => {
  let seedCount = 0;

  beforeAll(async () => {
    await cleanup();
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(classificationRuleSeeds);
    seedCount = row.n;
    expect(seedCount).toBeGreaterThan(0);
  });

  afterEach(cleanup);
  afterAll(async () => {
    await db.$client.end({ timeout: 1 });
  });

  it("copies every seed into classification_rules with user_id set", async () => {
    const userId = await createTestUser("basic");
    const inserted = await copyRuleSeedsToUser(userId);
    expect(inserted).toBe(seedCount);

    const rules = await db
      .select({ pattern: classificationRules.pattern })
      .from(classificationRules)
      .where(eq(classificationRules.userId, userId));
    expect(rules).toHaveLength(seedCount);
  });

  it("is idempotent — second call returns 0 and row count is stable", async () => {
    const userId = await createTestUser("idempotent");
    const first = await copyRuleSeedsToUser(userId);
    expect(first).toBe(seedCount);

    const second = await copyRuleSeedsToUser(userId);
    expect(second).toBe(0);

    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(classificationRules)
      .where(eq(classificationRules.userId, userId));
    expect(row.n).toBe(seedCount);
  });

  it("tops up a partial rule set", async () => {
    const userId = await createTestUser("partial");
    // Simulate a user who manually deleted one rule: copy, then delete one,
    // then copy again — the second call should re-insert only the missing row.
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
    expect(row.n).toBe(seedCount);
  });

  it("keeps users isolated — copying for userB does not affect userA", async () => {
    const userA = await createTestUser("iso-a");
    const userB = await createTestUser("iso-b");

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

    expect(countA.n).toBe(seedCount);
    expect(countB.n).toBe(seedCount);
  });
});
