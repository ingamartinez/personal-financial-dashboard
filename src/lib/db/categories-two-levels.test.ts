import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { categories, users } from "@/lib/db/schema";

// #810: categories_enforce_two_levels must scope depth checks by user_id
// and ignore soft-deleted rows. Without that, one tenant's taxonomy shape
// constrains another's.

const TAG = "CAT_LEVELS_810";

let userA: number;
let userB: number;

async function cleanupUsers(): Promise<void> {
  await db.execute(
    sql`DELETE FROM categories WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"}) AND parent_slug IS NOT NULL`,
  );
  await db.execute(
    sql`DELETE FROM categories WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})`,
  );
  await db.delete(users).where(sql`email LIKE ${TAG + "%"}`);
}

async function wipeCategories(): Promise<void> {
  await db.execute(
    sql`DELETE FROM categories WHERE user_id IN (${userA}, ${userB}) AND parent_slug IS NOT NULL`,
  );
  await db.execute(sql`DELETE FROM categories WHERE user_id IN (${userA}, ${userB})`);
}

async function createUser(suffix: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email: `${TAG}-${suffix}@test.local`, name: `${TAG}-${suffix}` })
    .returning({ id: users.id });
  return row.id;
}

function postgresText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? err.cause.message : String(err.cause ?? "");
  return `${err.message}\n${cause}`;
}

async function insertCategory(
  userId: number,
  slug: string,
  opts: { parentSlug?: string | null; deletedAt?: Date | null } = {},
) {
  const [row] = await db
    .insert(categories)
    .values({
      userId,
      slug,
      name: slug,
      parentSlug: opts.parentSlug ?? null,
      sortOrder: 0,
      deletedAt: opts.deletedAt ?? null,
    })
    .returning({
      id: categories.id,
      slug: categories.slug,
      parentSlug: categories.parentSlug,
    });
  return row;
}

describe("#810 categories_enforce_two_levels tenant scope", () => {
  beforeAll(async () => {
    await cleanupUsers();
    userA = await createUser("A");
    userB = await createUser("B");
  });

  afterEach(async () => {
    await wipeCategories();
  });

  afterAll(async () => {
    await cleanupUsers();
  });

  it("lets user A create top-level foo + a child while user B has foo as a child", async () => {
    await insertCategory(userB, "housing");
    await insertCategory(userB, "foo", { parentSlug: "housing" });

    const top = await insertCategory(userA, "foo");
    const child = await insertCategory(userA, "foo-child", { parentSlug: "foo" });

    expect(top.parentSlug).toBeNull();
    expect(child.parentSlug).toBe("foo");
  });

  it("ignores another tenant's soft-deleted category when checking depth", async () => {
    await insertCategory(userB, "housing");
    await insertCategory(userB, "foo", {
      parentSlug: "housing",
      deletedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const top = await insertCategory(userA, "foo");
    const child = await insertCategory(userA, "foo-child", { parentSlug: "foo" });

    expect(top.parentSlug).toBeNull();
    expect(child.parentSlug).toBe("foo");
  });

  it("still rejects a grandchild within a single user", async () => {
    await insertCategory(userA, "food");
    await insertCategory(userA, "restaurants", { parentSlug: "food" });

    await expect(insertCategory(userA, "pizza", { parentSlug: "restaurants" })).rejects.toSatisfy(
      (err: unknown) => /parent restaurants is itself a child/.test(postgresText(err)),
    );
  });

  it("still rejects turning a live parent into a child within a single user", async () => {
    await insertCategory(userA, "food");
    await insertCategory(userA, "restaurants", { parentSlug: "food" });
    await insertCategory(userA, "other");

    await expect(
      db
        .update(categories)
        .set({ parentSlug: "other" })
        .where(sql`user_id = ${userA} AND slug = 'food'`),
    ).rejects.toSatisfy((err: unknown) =>
      /food already has children and cannot become a child/.test(postgresText(err)),
    );
  });
});
