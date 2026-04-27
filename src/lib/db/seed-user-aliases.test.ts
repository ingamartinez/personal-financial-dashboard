// Integration tests for seedUserAliases (#538).
//
// These tests hit findash_test (forced by vitest.setup.ts). Run
// `bun run db:migrate:test` before this suite.
//
// Test matrix:
//   1. No user with target email → no-op, no error, no inserts.
//   2. User exists, fresh user_aliases → inserts all 3 canonical aliases.
//   3. Idempotency: run twice → second run inserts 0 (no duplicates).
//   4. Deprecated cleanup: deprecated alias present → deleted; canonical 3 present.
//   5. Tenant safety: deprecated alias on a DIFFERENT user is NOT touched.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { userAliases, users } from "@/lib/db/schema";
import { USER_ALIAS_SEEDS, seedUserAliases } from "./seed-user-aliases";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Stable tag to isolate test rows; all inserts use email addresses prefixed
// with this tag so cleanup is a simple LIKE query.
const TAG = "SEED_UA_TEST";

const CANONICAL_ALIASES = USER_ALIAS_SEEDS[0].aliases;
const DEPRECATED_ALIASES = USER_ALIAS_SEEDS[0].deprecated;

const testEmail = (suffix: string) => `${TAG}-${suffix}@test.local`;

async function cleanup(): Promise<void> {
  await db.execute(
    sql`DELETE FROM user_aliases WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})`,
  );
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${TAG + "%"}`);
}

beforeAll(cleanup);
afterAll(cleanup);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertUser(email: string, name = "Test User"): Promise<number> {
  const [u] = await db.insert(users).values({ email, name }).returning({ id: users.id });
  return u.id;
}

async function getAliasesForUser(userId: number): Promise<string[]> {
  const rows = await db
    .select({ alias: userAliases.alias })
    .from(userAliases)
    .where(eq(userAliases.userId, userId));
  return rows.map((r) => r.alias).sort();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("seedUserAliases", () => {
  it("no-ops when no user with target email exists", async () => {
    const email = testEmail("nonexistent");

    // Should not throw.
    await expect(
      seedUserAliases(db, [{ email, aliases: CANONICAL_ALIASES, deprecated: DEPRECATED_ALIASES }]),
    ).resolves.toBeUndefined();

    // No alias rows inserted (user doesn't exist, seed should skip).
    const [{ count }] = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*) AS count FROM user_aliases WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`,
    );
    expect(Number(count)).toBe(0);
  });

  it("inserts all canonical aliases when user exists and aliases table is empty", async () => {
    const email = testEmail("fresh");
    const userId = await insertUser(email);

    await seedUserAliases(db, [
      { email, aliases: CANONICAL_ALIASES, deprecated: DEPRECATED_ALIASES },
    ]);

    const aliases = await getAliasesForUser(userId);
    expect(aliases).toEqual([...CANONICAL_ALIASES].sort());
    expect(aliases).toHaveLength(CANONICAL_ALIASES.length);
  });

  it("is idempotent — second run inserts 0 rows", async () => {
    const email = testEmail("idempotent");
    const userId = await insertUser(email);

    const spec = [{ email, aliases: CANONICAL_ALIASES, deprecated: DEPRECATED_ALIASES }];

    await seedUserAliases(db, spec);
    // Second call — must not throw, must not duplicate.
    await seedUserAliases(db, spec);

    const aliases = await getAliasesForUser(userId);
    // Still exactly the canonical set — no duplicates.
    expect(aliases).toEqual([...CANONICAL_ALIASES].sort());
    expect(aliases).toHaveLength(CANONICAL_ALIASES.length);
  });

  it("removes deprecated aliases and inserts canonical ones", async () => {
    const email = testEmail("deprecated");
    const userId = await insertUser(email);

    // Pre-insert one deprecated alias before running the seed.
    const deprecated0 = DEPRECATED_ALIASES[0];
    await db.insert(userAliases).values({ userId, alias: deprecated0 });

    await seedUserAliases(db, [
      { email, aliases: CANONICAL_ALIASES, deprecated: DEPRECATED_ALIASES },
    ]);

    const aliases = await getAliasesForUser(userId);

    // Canonical 3 are present.
    expect(aliases).toEqual([...CANONICAL_ALIASES].sort());

    // Deprecated alias is gone.
    expect(aliases).not.toContain(deprecated0);
  });

  it("does NOT touch deprecated aliases belonging to a different user (tenant safety)", async () => {
    // Main user: seed will clean their deprecated aliases.
    const emailMain = testEmail("tenant-main");
    const userIdMain = await insertUser(emailMain);

    // Unrelated user who happens to share the same deprecated alias string —
    // their row must be untouched (proves DELETE is scoped by user_id).
    const emailOther = testEmail("tenant-other");
    const userIdOther = await insertUser(emailOther);

    const deprecated0 = DEPRECATED_ALIASES[0]; // e.g. "Alejandro Rafael"

    // Pre-insert the deprecated alias for BOTH users.
    await db.insert(userAliases).values([
      { userId: userIdMain, alias: deprecated0 },
      { userId: userIdOther, alias: deprecated0 },
    ]);

    // Run seed scoped to main user only.
    await seedUserAliases(db, [
      { email: emailMain, aliases: CANONICAL_ALIASES, deprecated: DEPRECATED_ALIASES },
    ]);

    // Main user: deprecated alias removed, canonical 3 present.
    const mainAliases = await getAliasesForUser(userIdMain);
    expect(mainAliases).toEqual([...CANONICAL_ALIASES].sort());
    expect(mainAliases).not.toContain(deprecated0);

    // Other user: their row is UNTOUCHED — proves tenant safety.
    const otherAliases = await getAliasesForUser(userIdOther);
    expect(otherAliases).toContain(deprecated0);
  });
});
