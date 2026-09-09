import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, recurringDescriptionPatterns, recurringTransactions } from "@/lib/db/schema";
import { fetchPatterns, fetchPatternsForOne } from "./patterns";

const TEST_USER_ID = 1;
const TEST_ACCOUNT = "__patterns_test_account__";

async function cleanup() {
  await db.execute(
    sql`DELETE FROM recurring_description_patterns WHERE recurring_id IN (SELECT id FROM recurring_transactions WHERE label LIKE '__patterns_test%')`,
  );
  await db.execute(sql`DELETE FROM recurring_transactions WHERE label LIKE '__patterns_test%'`);
  await db.execute(sql`DELETE FROM accounts WHERE name = ${TEST_ACCOUNT}`);
}

async function seedAccount() {
  const [a] = await db
    .insert(accounts)
    .values({
      userId: TEST_USER_ID,
      name: TEST_ACCOUNT,
      institution: "Test",
      type: "savings",
      currency: "COP",
    })
    .returning({ id: accounts.id });
  return a.id;
}

async function seedRecurring(accountId: number, label: string) {
  const [r] = await db
    .insert(recurringTransactions)
    .values({
      userId: TEST_USER_ID,
      accountId,
      label,
      amountCents: BigInt(-100000),
      currency: "COP",
      dayOfMonth: 1,
      active: true,
    })
    .returning({ id: recurringTransactions.id });
  return r.id;
}

describe("fetchPatterns / fetchPatternsForOne", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("excludes patterns with observation_count < 2", async () => {
    const accountId = await seedAccount();
    const recurringId = await seedRecurring(accountId, "__patterns_test low count");
    await db.insert(recurringDescriptionPatterns).values({
      userId: TEST_USER_ID,
      recurringId,
      pattern: "SPOTIFY",
      observationCount: 1,
    });

    const patterns = await fetchPatternsForOne(TEST_USER_ID, recurringId);
    expect(patterns).toEqual([]);
  });

  it("includes patterns with observation_count >= 2", async () => {
    const accountId = await seedAccount();
    const recurringId = await seedRecurring(accountId, "__patterns_test high count");
    await db.insert(recurringDescriptionPatterns).values({
      userId: TEST_USER_ID,
      recurringId,
      pattern: "NETFLIX",
      observationCount: 2,
    });

    const patterns = await fetchPatternsForOne(TEST_USER_ID, recurringId);
    expect(patterns).toEqual(["NETFLIX"]);
  });

  // #804 redefined shared-token ambiguity as "requires a second signal"
  // (resolved by the token+amount scorer) instead of a filtered-out flag.
  // #807 dropped the pattern_ambiguous column entirely — there is no longer
  // a flag to set, so the "includes regardless of ambiguity" case above is
  // now just the ordinary observation_count >= 2 case covered above.

  it("batches multiple recurrings in one call, keyed correctly", async () => {
    const accountId = await seedAccount();
    const recA = await seedRecurring(accountId, "__patterns_test batch A");
    const recB = await seedRecurring(accountId, "__patterns_test batch B");
    await db.insert(recurringDescriptionPatterns).values([
      { userId: TEST_USER_ID, recurringId: recA, pattern: "APPLE", observationCount: 2 },
      { userId: TEST_USER_ID, recurringId: recB, pattern: "GOOGLE", observationCount: 2 },
      { userId: TEST_USER_ID, recurringId: recB, pattern: "DLO", observationCount: 5 },
    ]);

    const map = await fetchPatterns(TEST_USER_ID, [recA, recB]);
    expect(map.get(recA)).toEqual(["APPLE"]);
    expect(map.get(recB)?.sort()).toEqual(["DLO", "GOOGLE"]);
  });

  it("returns an empty map for an empty recurringIds array without querying", async () => {
    const map = await fetchPatterns(TEST_USER_ID, []);
    expect(map.size).toBe(0);
  });

  it("does not leak another user's patterns", async () => {
    const accountId = await seedAccount();
    const recurringId = await seedRecurring(accountId, "__patterns_test tenant");
    await db.insert(recurringDescriptionPatterns).values({
      userId: TEST_USER_ID,
      recurringId,
      pattern: "NETFLIX",
      observationCount: 2,
    });

    const patterns = await fetchPatternsForOne(999999, recurringId);
    expect(patterns).toEqual([]);
  });
});
