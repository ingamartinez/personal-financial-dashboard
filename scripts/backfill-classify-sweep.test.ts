// #809 reviewer WARNING 3: the backfill script must not silently proceed (or
// self-heal by inserting categories) when a target user is missing the
// "rendimientos" category that migrate-prod.ts's deploy flow is responsible
// for materializing. It must abort with a clear, actionable error instead.

import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { categories, users } from "../src/lib/db/schema";
import { ensureRendimientosCategoryExists } from "./backfill-classify-sweep";

const TAG = "BACKFILL_SWEEP_TEST";

async function createBareUser(email: string): Promise<number> {
  // Deliberately does NOT call copyCategorySeedsToUser — this user has zero
  // categories, simulating "deploy-time category seed hasn't materialized
  // for this user yet".
  const [row] = await db.insert(users).values({ email, name: email }).returning({ id: users.id });
  return row.id;
}

async function cleanup() {
  await db.delete(users).where(sql`email LIKE ${"%" + TAG + "%"}`);
}

afterEach(cleanup);

describe("ensureRendimientosCategoryExists (#809 backfill precondition)", () => {
  it("throws a clear, actionable error naming the fix when the category is missing", async () => {
    const uid = await createBareUser(`${TAG}-missing-${Date.now()}-${Math.random()}@test.local`);

    await expect(ensureRendimientosCategoryExists(uid)).rejects.toThrow(/rendimientos/i);
    await expect(ensureRendimientosCategoryExists(uid)).rejects.toThrow(/db:backfill:users/);
  });

  it("does NOT self-heal by inserting the category", async () => {
    const uid = await createBareUser(`${TAG}-nosidefx-${Date.now()}-${Math.random()}@test.local`);

    await expect(ensureRendimientosCategoryExists(uid)).rejects.toThrow();

    const [row] = await db
      .select({ slug: categories.slug })
      .from(categories)
      .where(sql`${categories.userId} = ${uid} AND ${categories.slug} = 'rendimientos'`);
    expect(row).toBeUndefined();
  });

  it("resolves cleanly once the category exists for the user", async () => {
    const uid = await createBareUser(`${TAG}-ok-${Date.now()}-${Math.random()}@test.local`);
    await db.insert(categories).values({
      userId: uid,
      slug: "rendimientos",
      name: "Rendimientos",
      parentSlug: null,
    });

    await expect(ensureRendimientosCategoryExists(uid)).resolves.toBeUndefined();
  });

  it("no-op when the target user doesn't exist or isn't active", async () => {
    await expect(ensureRendimientosCategoryExists(999_999_999)).resolves.toBeUndefined();
  });
});
