// #809 reviewer WARNING 3: the backfill script must not silently proceed (or
// self-heal by inserting categories) when a target user is missing the
// "rendimientos" category that migrate-prod.ts's deploy flow is responsible
// for materializing. It must abort with a clear, actionable error instead.

import { afterEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { accounts, categories, transactions, users } from "../src/lib/db/schema";
import { copyCategorySeedsToUser } from "../src/lib/auth/signup";
import {
  assignManualHomeGoodsTx,
  ensureHomeGoodsCategoriesExist,
  ensureRendimientosCategoryExists,
  type ManualHomeGoodsAssignment,
} from "./backfill-classify-sweep";

const TAG = "BACKFILL_SWEEP_TEST";

async function createBareUser(email: string): Promise<number> {
  // Deliberately does NOT call copyCategorySeedsToUser — this user has zero
  // categories, simulating "deploy-time category seed hasn't materialized
  // for this user yet".
  const [row] = await db.insert(users).values({ email, name: email }).returning({ id: users.id });
  return row.id;
}

async function createFullUser(email: string): Promise<number> {
  const [row] = await db.insert(users).values({ email, name: email }).returning({ id: users.id });
  await copyCategorySeedsToUser(row.id);
  return row.id;
}

async function createAccountFor(userId: number): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({ userId, name: `${TAG} account`, institution: TAG, type: "savings", currency: "COP" })
    .returning({ id: accounts.id });
  return row.id;
}

let seq = 0;
async function createTx(args: {
  userId: number;
  accountId: number;
  descriptionRaw: string;
  categorySlug: string | null;
  classificationMethod: string;
}): Promise<number> {
  seq++;
  const [row] = await db.execute<{ id: number }>(sql`
    INSERT INTO transactions (
      user_id, account_id, occurred_at, amount_cents, currency,
      description_raw, category_slug, classification_method,
      source, external_id, channel
    ) VALUES (
      ${args.userId}, ${args.accountId}, now(), -10000, 'COP',
      ${args.descriptionRaw}, ${args.categorySlug},
      ${args.classificationMethod}::classification_method,
      'sms', ${`${TAG}-${seq}`}, 'bank'::tx_channel
    )
    RETURNING id
  `);
  return row.id;
}

async function getTx(id: number) {
  const [row] = await db
    .select({
      categorySlug: transactions.categorySlug,
      classificationMethod: transactions.classificationMethod,
      classificationConfidence: transactions.classificationConfidence,
    })
    .from(transactions)
    .where(eq(transactions.id, id));
  return row;
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

describe("ensureHomeGoodsCategoriesExist (#812 backfill precondition)", () => {
  it("throws naming the missing (user_id, slug) pair for a user-created category (regalos)", async () => {
    // Seeded categories (muebles/hogar/vivienda/tecnologia) materialize via
    // copyCategorySeedsToUser, but "regalos" is a user-created category no
    // seed knows about — it must be verified separately, not assumed.
    const uid = await createFullUser(
      `${TAG}-regalos-missing-${Date.now()}-${Math.random()}@test.local`,
    );
    const fixture: ManualHomeGoodsAssignment[] = [
      { txId: 1, userId: uid, categorySlug: "regalos", label: "test gift" },
    ];

    await expect(ensureHomeGoodsCategoriesExist(fixture, uid)).rejects.toThrow(/regalos/);
    await expect(ensureHomeGoodsCategoriesExist(fixture, uid)).rejects.toThrow(
      new RegExp(`\\(${uid}, regalos\\)`),
    );
  });

  it("names EVERY missing pair at once, not just the first", async () => {
    const uid = await createBareUser(
      `${TAG}-multi-missing-${Date.now()}-${Math.random()}@test.local`,
    );
    const fixture: ManualHomeGoodsAssignment[] = [
      { txId: 1, userId: uid, categorySlug: "muebles", label: "a" },
      { txId: 2, userId: uid, categorySlug: "hogar", label: "b" },
    ];

    await expect(ensureHomeGoodsCategoriesExist(fixture, uid)).rejects.toThrow(
      new RegExp(
        `\\(${uid}, muebles\\).*\\(${uid}, hogar\\)|\\(${uid}, hogar\\).*\\(${uid}, muebles\\)`,
      ),
    );
  });

  it("does NOT self-heal by inserting the missing category", async () => {
    const uid = await createFullUser(
      `${TAG}-regalos-nosidefx-${Date.now()}-${Math.random()}@test.local`,
    );
    const fixture: ManualHomeGoodsAssignment[] = [
      { txId: 1, userId: uid, categorySlug: "regalos", label: "test gift" },
    ];

    await expect(ensureHomeGoodsCategoriesExist(fixture, uid)).rejects.toThrow();

    const [row] = await db
      .select({ slug: categories.slug })
      .from(categories)
      .where(sql`${categories.userId} = ${uid} AND ${categories.slug} = 'regalos'`);
    expect(row).toBeUndefined();
  });

  it("resolves once every target category exists, including a user-created one", async () => {
    const uid = await createFullUser(`${TAG}-regalos-ok-${Date.now()}-${Math.random()}@test.local`);
    await db.insert(categories).values({
      userId: uid,
      slug: "regalos",
      name: "Regalos",
      parentSlug: null,
    });
    // Every distinct category slug the real 16-row #812 assignment map uses.
    const fixture: ManualHomeGoodsAssignment[] = [
      "muebles",
      "hogar",
      "vivienda",
      "entretenimiento",
      "tecnologia",
      "transporte",
      "regalos",
      "salud",
    ].map((slug, i) => ({ txId: i + 1, userId: uid, categorySlug: slug, label: slug }));

    await expect(ensureHomeGoodsCategoriesExist(fixture, uid)).resolves.toBeUndefined();
  });

  it("only checks assignments in scope for the given userId", async () => {
    const uid = await createFullUser(`${TAG}-scope-${Date.now()}-${Math.random()}@test.local`);
    const otherUid = 999_999_998; // never created — would fail the check if not filtered out
    const fixture: ManualHomeGoodsAssignment[] = [
      { txId: 1, userId: otherUid, categorySlug: "regalos", label: "not in scope" },
    ];

    await expect(ensureHomeGoodsCategoriesExist(fixture, uid)).resolves.toBeUndefined();
  });
});

describe("assignManualHomeGoodsTx (#812)", () => {
  it("assigns all 16 in-scope txs to their target category as manual, and a second run is a no-op", async () => {
    const uid = await createFullUser(`${TAG}-assign-${Date.now()}-${Math.random()}@test.local`);
    const accountId = await createAccountFor(uid);
    await db.insert(categories).values({
      userId: uid,
      slug: "regalos",
      name: "Regalos",
      parentSlug: null,
    });

    // Mirrors the real #812 map's 16 rows: muebles x2, hogar x7, vivienda x1,
    // entretenimiento x1, tecnologia x1, transporte x1, regalos x1, salud x2.
    const slugs = [
      "muebles",
      "muebles",
      "hogar",
      "hogar",
      "hogar",
      "hogar",
      "hogar",
      "hogar",
      "hogar",
      "vivienda",
      "entretenimiento",
      "tecnologia",
      "transporte",
      "regalos",
      "salud",
      "salud",
    ];
    expect(slugs).toHaveLength(16);

    const fixture: ManualHomeGoodsAssignment[] = [];
    for (const [i, slug] of slugs.entries()) {
      const txId = await createTx({
        userId: uid,
        accountId,
        descriptionRaw: `HOME GOODS ${slug} ${i}`,
        categorySlug: null,
        classificationMethod: "unclassified",
      });
      fixture.push({ txId, userId: uid, categorySlug: slug, label: `${slug} ${i}` });
    }

    const first = await assignManualHomeGoodsTx(fixture, uid);
    expect(first.every((r) => r.updated)).toBe(true);
    expect(first).toHaveLength(16);

    for (const a of fixture) {
      const row = await getTx(a.txId);
      expect(row?.categorySlug).toBe(a.categorySlug);
      expect(row?.classificationMethod).toBe("manual");
      expect(row?.classificationConfidence).toBe(100);
    }

    // Second run: idempotent no-op — every row is already 'manual'.
    const second = await assignManualHomeGoodsTx(fixture, uid);
    expect(second.every((r) => !r.updated)).toBe(true);
    for (const a of fixture) {
      const row = await getTx(a.txId);
      expect(row?.categorySlug).toBe(a.categorySlug);
    }
  });

  it("never clobbers a row already manual/manual_confirmed under a DIFFERENT category (a later human edit)", async () => {
    const uid = await createFullUser(`${TAG}-noclobber-${Date.now()}-${Math.random()}@test.local`);
    const accountId = await createAccountFor(uid);
    const txId = await createTx({
      userId: uid,
      accountId,
      descriptionRaw: "ALREADY DECIDED",
      categorySlug: "vivienda",
      classificationMethod: "manual_confirmed",
    });
    const fixture: ManualHomeGoodsAssignment[] = [
      { txId, userId: uid, categorySlug: "muebles", label: "should not apply" },
    ];

    const result = await assignManualHomeGoodsTx(fixture, uid);

    expect(result[0]).toEqual({ txId, updated: false });
    const row = await getTx(txId);
    expect(row?.categorySlug).toBe("vivienda");
    expect(row?.classificationMethod).toBe("manual_confirmed");
  });

  it("skips (and warns, does not throw) when the tx doesn't exist for the (txId, userId) pair", async () => {
    const uid = await createFullUser(`${TAG}-notfound-${Date.now()}-${Math.random()}@test.local`);
    const fixture: ManualHomeGoodsAssignment[] = [
      { txId: 999_999_999, userId: uid, categorySlug: "muebles", label: "ghost tx" },
    ];

    await expect(assignManualHomeGoodsTx(fixture, uid)).resolves.toEqual([
      { txId: 999_999_999, updated: false },
    ]);
  });

  it("skips an assignment out of scope for the given --user-id", async () => {
    const uid = await createFullUser(`${TAG}-outofscope-${Date.now()}-${Math.random()}@test.local`);
    const otherUid = 999_999_997;
    const fixture: ManualHomeGoodsAssignment[] = [
      { txId: 1, userId: otherUid, categorySlug: "muebles", label: "not this user" },
    ];

    await expect(assignManualHomeGoodsTx(fixture, uid)).resolves.toEqual([
      { txId: 1, updated: false },
    ]);
  });
});

describe("HOME_GOODS_MANUAL_ASSIGNMENTS (#812 real assignment map)", () => {
  it("has exactly 16 rows, all for user 1, with no duplicate tx ids", async () => {
    const { HOME_GOODS_MANUAL_ASSIGNMENTS } = await import("./backfill-classify-sweep");

    expect(HOME_GOODS_MANUAL_ASSIGNMENTS).toHaveLength(16);
    expect(HOME_GOODS_MANUAL_ASSIGNMENTS.every((a) => a.userId === 1)).toBe(true);

    const txIds = HOME_GOODS_MANUAL_ASSIGNMENTS.map((a) => a.txId);
    expect(new Set(txIds).size).toBe(txIds.length);
  });

  it("only targets the 8 expected category slugs", async () => {
    const { HOME_GOODS_MANUAL_ASSIGNMENTS } = await import("./backfill-classify-sweep");

    const expectedSlugs = new Set([
      "muebles",
      "hogar",
      "vivienda",
      "entretenimiento",
      "tecnologia",
      "transporte",
      "regalos",
      "salud",
    ]);
    for (const a of HOME_GOODS_MANUAL_ASSIGNMENTS) {
      expect(expectedSlugs.has(a.categorySlug)).toBe(true);
    }
  });
});
