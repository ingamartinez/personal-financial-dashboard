import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  recurringDescriptionPatterns,
  recurringLinkObservations,
  recurringTransactions,
  transactions,
} from "@/lib/db/schema";
import {
  fetchAmountConsistentTokens,
  fetchPatterns,
  fetchPatternsForOne,
  patternSetsEqual,
} from "./patterns";

const TEST_USER_ID = 1;
const TEST_ACCOUNT = "__patterns_test_account__";

async function cleanup() {
  await db.execute(
    sql`DELETE FROM recurring_link_observations WHERE recurring_id IN (SELECT id FROM recurring_transactions WHERE label LIKE '__patterns_test%')`,
  );
  await db.execute(
    sql`DELETE FROM recurring_description_patterns WHERE recurring_id IN (SELECT id FROM recurring_transactions WHERE label LIKE '__patterns_test%')`,
  );
  await db.execute(
    sql`DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE name = ${TEST_ACCOUNT})`,
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

describe("patternSetsEqual", () => {
  it("treats two empty sets as equal (cold-start)", () => {
    expect(patternSetsEqual(new Set(), new Set())).toBe(true);
  });

  it("treats identical tokens as equal regardless of insertion order", () => {
    expect(patternSetsEqual(new Set(["UNE", "TIGO"]), new Set(["TIGO", "UNE"]))).toBe(true);
  });

  it("rejects different sizes or different tokens", () => {
    expect(patternSetsEqual(new Set(["UNE"]), new Set(["UNE", "TIGO"]))).toBe(false);
    expect(patternSetsEqual(new Set(["UNE"]), new Set(["NETFLIX"]))).toBe(false);
  });
});

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

describe("fetchAmountConsistentTokens #873", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  async function seedTx(
    accountId: number,
    opts: { amountCents: bigint; currency?: "COP" | "USD"; description: string },
  ) {
    const [t] = await db
      .insert(transactions)
      .values({
        userId: TEST_USER_ID,
        accountId,
        occurredAt: new Date("2026-06-05T12:00:00-05:00"),
        amountCents: opts.amountCents,
        currency: opts.currency ?? "COP",
        descriptionRaw: opts.description,
        source: "manual",
      })
      .returning({ id: transactions.id });
    return t.id;
  }

  it("returns tokens from amount-matching observations and ignores a wrong-amount mis-link", async () => {
    const accountId = await seedAccount();
    const recurringId = await seedRecurring(accountId, "__patterns_test rent sibling");
    const rentTx = await seedTx(accountId, {
      amountCents: BigInt(-230000000),
      description: "Transferencia a cuenta *138076518",
    });
    const poisonTx = await seedTx(accountId, {
      amountCents: BigInt(-11702),
      currency: "USD",
      description: "COLMEDICA PREPAGADA",
    });

    await db.insert(recurringLinkObservations).values([
      {
        userId: TEST_USER_ID,
        recurringId,
        txId: rentTx,
        yearMonth: "2026-06",
        realAmountCents: BigInt(-230000000),
        realCurrency: "COP",
        descriptionRaw: "Transferencia a cuenta *138076518",
        accountId,
        manual: true,
      },
      {
        userId: TEST_USER_ID,
        recurringId,
        txId: poisonTx,
        yearMonth: "2026-05",
        realAmountCents: BigInt(-11702),
        realCurrency: "USD",
        descriptionRaw: "COLMEDICA PREPAGADA",
        accountId,
        manual: false,
      },
    ]);

    const map = await fetchAmountConsistentTokens(
      TEST_USER_ID,
      [recurringId],
      BigInt(-230000000),
      "COP",
    );
    expect(map.get(recurringId)).toEqual(["TRANSFERENCIA"]);
  });

  it("returns an empty map for an empty recurringIds array without querying", async () => {
    const map = await fetchAmountConsistentTokens(TEST_USER_ID, [], BigInt(-1), "COP");
    expect(map.size).toBe(0);
  });
});
