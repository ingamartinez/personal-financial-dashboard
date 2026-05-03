// #750: Integration test for the institution_slug filter in TcConsolidationStatus.
//
// Regression: accounts with institution_slug='other' AND institution='Bancolombia'
// (e.g. Amex *5367, MC *8268) were excluded from the query. The fix adds an OR
// branch for this case so these cards appear in the consolidation panel.
//
// Runs against findash_test DB (forced by vitest.setup.ts).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, ilike, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { accounts, users } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedUser(email: string): Promise<number> {
  const [u] = await db
    .insert(users)
    .values({ email, name: `Test ${email}`, role: "user" })
    .returning({ id: users.id });
  if (!u) throw new Error(`Failed to seed user ${email}`);
  return u.id;
}

async function seedCcAccount(
  userId: number,
  opts: {
    institution: string;
    institutionSlug: string;
    name?: string;
  },
): Promise<number> {
  const [a] = await db
    .insert(accounts)
    .values({
      userId,
      name: opts.name ?? "Test CC",
      institution: opts.institution,
      institutionSlug: opts.institutionSlug as "bancolombia" | "other",
      type: "credit_card",
      currency: "COP",
      active: true,
    })
    .returning({ id: accounts.id });
  if (!a) throw new Error(`Failed to seed account for user ${userId}`);
  return a.id;
}

/** The exact same query used in TcConsolidationStatus. */
async function queryTcAccounts(userId: number) {
  return db
    .select({ id: accounts.id, institutionSlug: accounts.institutionSlug })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.type, "credit_card"),
        or(
          eq(accounts.institutionSlug, "bancolombia"),
          and(eq(accounts.institutionSlug, "other"), ilike(accounts.institution, "bancolombia")),
        ),
        notDeleted(accounts.deletedAt),
      ),
    )
    .orderBy(asc(accounts.name));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TcConsolidationStatus — institution_slug query filter (#750)", () => {
  const TEST_EMAIL = `tc-consolidation-test-${Date.now()}@test.findash`;
  let userId: number;
  let normalAccountId: number;
  let otherSlugAccountId: number;

  beforeEach(async () => {
    userId = await seedUser(TEST_EMAIL);

    // Account with the correct slug (should always be included)
    normalAccountId = await seedCcAccount(userId, {
      institution: "Bancolombia",
      institutionSlug: "bancolombia",
      name: "Bancolombia Visa",
    });

    // Account with slug='other' but institution='Bancolombia' (the bug scenario)
    // This mimics Amex *5367 and MC *8268 as found in prod.
    otherSlugAccountId = await seedCcAccount(userId, {
      institution: "Bancolombia",
      institutionSlug: "other",
      name: "Bancolombia Amex",
    });
  });

  afterEach(async () => {
    // Clean up: delete accounts first (FK), then user
    await db.execute(sql`DELETE FROM accounts WHERE user_id = ${userId}`);
    await db.delete(users).where(eq(users.id, userId));
  });

  it("includes accounts with institution_slug='bancolombia'", async () => {
    const rows = await queryTcAccounts(userId);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(normalAccountId);
  });

  it("includes accounts with institution_slug='other' AND institution ILIKE 'bancolombia'", async () => {
    const rows = await queryTcAccounts(userId);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(otherSlugAccountId);
  });

  it("returns both accounts in a single query", async () => {
    const rows = await queryTcAccounts(userId);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});
