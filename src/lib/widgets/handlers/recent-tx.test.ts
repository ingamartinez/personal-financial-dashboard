import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, categories, fxRates, transactions, users } from "@/lib/db/schema";
import { recentTxHandler } from "./recent-tx";

// Cleanup gate: everything this suite touches is tagged so the delete queries
// only remove what we own. Matches the hoy / mis-tcs / tc-focus pattern.
const MARKER = "__widget_recent_tx_test";

// Stable, far-future FX date so getCurrentFxRate() returns our seeded row
// (it ORDERs BY as_of DESC) regardless of any other rates in findash_test.
const TEST_FX_DATE = "9999-01-01";

let USER_A = 0;
let USER_B = 0;
let ACCT_A_COP = 0;
let ACCT_A_USD = 0;
let ACCT_B_COP = 0;

async function cleanup() {
  await db.execute(
    sql`DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE name LIKE ${MARKER + "%"})`,
  );
}

beforeAll(async () => {
  const [a] = await db
    .insert(users)
    .values({ email: `${MARKER}-a@test.local`, name: "A" })
    .returning({ id: users.id });
  const [b] = await db
    .insert(users)
    .values({ email: `${MARKER}-b@test.local`, name: "B" })
    .returning({ id: users.id });
  USER_A = a.id;
  USER_B = b.id;

  const [acopA] = await db
    .insert(accounts)
    .values({
      userId: USER_A,
      name: `${MARKER}-a-cop`,
      institution: "Bancolombia",
      type: "savings",
      currency: "COP",
    })
    .returning({ id: accounts.id });
  const [ausdA] = await db
    .insert(accounts)
    .values({
      userId: USER_A,
      name: `${MARKER}-a-usd`,
      institution: "Amex",
      type: "credit_card",
      currency: "USD",
      metadata: { last4s: ["1234"], network: "amex" },
    })
    .returning({ id: accounts.id });
  const [acopB] = await db
    .insert(accounts)
    .values({
      userId: USER_B,
      name: `${MARKER}-b-cop`,
      institution: "Bancolombia",
      type: "savings",
      currency: "COP",
    })
    .returning({ id: accounts.id });
  ACCT_A_COP = acopA.id;
  ACCT_A_USD = ausdA.id;
  ACCT_B_COP = acopB.id;

  // Both users get a `mercado` category with identical slug but different
  // names + icons. This is the heart of the cross-tenant guard: the JOIN
  // on slug alone would collide these, the JOIN on (userId, slug) won't.
  await db
    .insert(categories)
    .values({
      userId: USER_A,
      slug: "mercado",
      name: "Supermercado",
      icon: "shopping-cart",
      sortOrder: 10,
    })
    .onConflictDoNothing({ target: [categories.userId, categories.slug] });
  await db
    .insert(categories)
    .values({
      userId: USER_B,
      slug: "mercado",
      // Deliberately different name/icon to detect tenant leaks.
      name: "USER_B_MERCADO_NAME",
      icon: "USER_B_MERCADO_ICON",
      sortOrder: 10,
    })
    .onConflictDoNothing({ target: [categories.userId, categories.slug] });

  // TRM = 4000 for deterministic math on USD txs.
  await db
    .insert(fxRates)
    .values({
      base: "USD",
      quote: "COP",
      rateMicros: BigInt(4_000_000_000),
      asOf: TEST_FX_DATE,
      source: MARKER,
    })
    .onConflictDoUpdate({
      target: [fxRates.base, fxRates.quote, fxRates.asOf],
      set: { rateMicros: BigInt(4_000_000_000), source: MARKER },
    });
});

afterEach(cleanup);

afterAll(async () => {
  await db.execute(sql`DELETE FROM fx_rates WHERE source = ${MARKER}`);
  await db.execute(
    sql`DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE name LIKE ${MARKER + "%"})`,
  );
  await db.execute(sql`DELETE FROM accounts WHERE name LIKE ${MARKER + "%"}`);
  // Drop the categories we seeded — if another suite seeds the same (userId,
  // slug), it will still be safe because our users are ephemeral.
  await db.delete(categories).where(
    // Restrict cleanup to the test users only.
    and(eq(categories.slug, "mercado"), eq(categories.userId, USER_A)),
  );
  await db
    .delete(categories)
    .where(and(eq(categories.slug, "mercado"), eq(categories.userId, USER_B)));
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${MARKER + "%"}`);
  await db.$client.end({ timeout: 1 });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(params: { userId: number; size?: "S" | "M" | "L" }) {
  return {
    userId: params.userId,
    size: (params.size ?? "L") as "S" | "M" | "L",
    searchParams: new URLSearchParams(),
  };
}

type InsertTxOpts = {
  userId: number;
  accountId: number;
  occurredAt: Date;
  amountCents: number;
  currency?: "COP" | "USD";
  merchant?: string | null;
  categorySlug?: string | null;
  source?:
    | "apple_pay"
    | "sms"
    | "ocr"
    | "csv"
    | "recurring"
    | "manual"
    | "telegram"
    | "balance_adjustment"
    | "csv_reconcile";
  channel?: "bank" | "manual" | "transfer";
  isAdjustment?: boolean;
  deletedAt?: Date;
};

async function insertTx(opts: InsertTxOpts): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId: opts.userId,
      accountId: opts.accountId,
      occurredAt: opts.occurredAt,
      amountCents: BigInt(opts.amountCents),
      currency: opts.currency ?? "COP",
      descriptionRaw: `${MARKER} tx`,
      merchant: opts.merchant ?? null,
      categorySlug: opts.categorySlug ?? null,
      classificationMethod: "manual",
      source: opts.source ?? "manual",
      channel: opts.channel ?? "bank",
      isAdjustment: opts.isAdjustment ?? false,
      deletedAt: opts.deletedAt,
    })
    .returning({ id: transactions.id });
  return row.id;
}

type RecentTxItem = {
  id: string;
  occurred_at: string;
  merchant: string | null;
  amount_cop: number;
  category_name: string | null;
  category_emoji: string | null;
  account_label: string;
};

type SuccessBody = {
  widget_id: "recent-tx";
  size: "M" | "L";
  data: { transactions: RecentTxItem[] };
  generated_at: string;
};

type ErrorBody = { error: { code: string; message: string } };

// Canonical timestamps — ordering must be preserved by the handler.
const T6 = new Date("2026-04-21T18:00:00Z"); // newest
const T5 = new Date("2026-04-21T17:00:00Z");
const T4 = new Date("2026-04-21T16:00:00Z");
const T3 = new Date("2026-04-21T15:00:00Z");
const T2 = new Date("2026-04-21T14:00:00Z");
const T1 = new Date("2026-04-21T13:00:00Z"); // oldest

// ---------------------------------------------------------------------------
// Happy paths — size + ordering
// ---------------------------------------------------------------------------

describe("recentTxHandler — happy path", () => {
  it("returns 3 txs for size=M ordered occurred_at DESC", async () => {
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: T1,
      amountCents: -10_000_00,
      merchant: "M1",
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: T2,
      amountCents: -20_000_00,
      merchant: "M2",
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: T3,
      amountCents: -30_000_00,
      merchant: "M3",
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: T4,
      amountCents: -40_000_00,
      merchant: "M4",
    });

    const res = await recentTxHandler(makeCtx({ userId: USER_A, size: "M" }));
    expect(res.status).toBeUndefined();
    const body = res.body as SuccessBody;
    expect(body.widget_id).toBe("recent-tx");
    expect(body.size).toBe("M");
    expect(body.data.transactions).toHaveLength(3);
    // Newest first → M4, M3, M2.
    expect(body.data.transactions.map((t) => t.merchant)).toEqual(["M4", "M3", "M2"]);
    expect(body.generated_at).toMatch(/-05:00$/);
  });

  it("returns 5 txs for size=L ordered occurred_at DESC", async () => {
    // Seed 6 so we can confirm the limit trims to 5 AND the oldest is dropped.
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: T1,
      amountCents: -10_000_00,
      merchant: "M1",
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: T2,
      amountCents: -20_000_00,
      merchant: "M2",
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: T3,
      amountCents: -30_000_00,
      merchant: "M3",
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: T4,
      amountCents: -40_000_00,
      merchant: "M4",
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: T5,
      amountCents: -50_000_00,
      merchant: "M5",
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: T6,
      amountCents: -60_000_00,
      merchant: "M6",
    });

    const res = await recentTxHandler(makeCtx({ userId: USER_A, size: "L" }));
    const body = res.body as SuccessBody;
    expect(body.size).toBe("L");
    expect(body.data.transactions).toHaveLength(5);
    expect(body.data.transactions.map((t) => t.merchant)).toEqual(["M6", "M5", "M4", "M3", "M2"]);
  });

  it("returns what's available when user has fewer txs than size asks for", async () => {
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: T1,
      amountCents: -10_000_00,
      merchant: "only",
    });
    const res = await recentTxHandler(makeCtx({ userId: USER_A, size: "M" }));
    const body = res.body as SuccessBody;
    expect(body.data.transactions).toHaveLength(1);
    expect(body.data.transactions[0]?.merchant).toBe("only");
  });

  it("returns an empty array when the user has no txs", async () => {
    const res = await recentTxHandler(makeCtx({ userId: USER_A, size: "L" }));
    expect(res.status).toBeUndefined();
    const body = res.body as SuccessBody;
    expect(body.data.transactions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Exclusions & inclusions — feed-specific rules
// ---------------------------------------------------------------------------

describe("recentTxHandler — exclusions", () => {
  it("excludes soft-deleted transactions", async () => {
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: T2,
      amountCents: -10_000_00,
      merchant: "live",
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: T3, // newer, but archived
      amountCents: -99_000_00,
      merchant: "archived",
      deletedAt: T3,
    });
    const res = await recentTxHandler(makeCtx({ userId: USER_A, size: "L" }));
    const body = res.body as SuccessBody;
    expect(body.data.transactions).toHaveLength(1);
    expect(body.data.transactions[0]?.merchant).toBe("live");
  });

  it("excludes balance adjustments (is_adjustment flag)", async () => {
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: T2,
      amountCents: -10_000_00,
      merchant: "real",
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: T3,
      amountCents: -99_000_00,
      merchant: "adjustment",
      source: "balance_adjustment",
      channel: "manual",
      isAdjustment: true,
    });
    const res = await recentTxHandler(makeCtx({ userId: USER_A, size: "L" }));
    const body = res.body as SuccessBody;
    expect(body.data.transactions).toHaveLength(1);
    expect(body.data.transactions[0]?.merchant).toBe("real");
  });
});

describe("recentTxHandler — inclusions (feed, not spend)", () => {
  it("INCLUDES transfers", async () => {
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: T2,
      amountCents: -100_000_00,
      merchant: "pago TC",
      channel: "transfer",
    });
    const res = await recentTxHandler(makeCtx({ userId: USER_A, size: "L" }));
    const body = res.body as SuccessBody;
    expect(body.data.transactions).toHaveLength(1);
    expect(body.data.transactions[0]?.merchant).toBe("pago TC");
    expect(body.data.transactions[0]?.amount_cop).toBe(-100_000);
  });

  it("INCLUDES credits / refunds (positive amounts) and preserves sign", async () => {
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: T2,
      amountCents: 50_000_00, // refund
      merchant: "refund",
    });
    const res = await recentTxHandler(makeCtx({ userId: USER_A, size: "L" }));
    const body = res.body as SuccessBody;
    expect(body.data.transactions).toHaveLength(1);
    expect(body.data.transactions[0]?.amount_cop).toBe(50_000);
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant safety (memory: per-user-table-join-tenant-safety)
// ---------------------------------------------------------------------------

describe("recentTxHandler — tenant safety", () => {
  it("scopes the tx list to the authed user", async () => {
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: T2,
      amountCents: -10_000_00,
      merchant: "mine",
    });
    await insertTx({
      userId: USER_B,
      accountId: ACCT_B_COP,
      occurredAt: T3, // newer — must still NOT appear in A's feed
      amountCents: -999_999_00,
      merchant: "theirs",
    });

    const res = await recentTxHandler(makeCtx({ userId: USER_A, size: "L" }));
    const body = res.body as SuccessBody;
    expect(body.data.transactions).toHaveLength(1);
    expect(body.data.transactions[0]?.merchant).toBe("mine");
  });

  it("resolves category name/emoji from the authed user's row (never the other user's)", async () => {
    // USER_A has category `mercado` → "Supermercado" / "shopping-cart".
    // USER_B has category `mercado` → "USER_B_MERCADO_NAME" / "USER_B_MERCADO_ICON".
    // A tx on USER_A's account with categorySlug=mercado MUST resolve to A's
    // row, not B's. This is exactly #336 / #338 regressed against.
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: T2,
      amountCents: -10_000_00,
      merchant: "exito",
      categorySlug: "mercado",
    });

    const res = await recentTxHandler(makeCtx({ userId: USER_A, size: "L" }));
    const body = res.body as SuccessBody;
    expect(body.data.transactions).toHaveLength(1);
    const row = body.data.transactions[0];
    expect(row?.category_name).toBe("Supermercado");
    expect(row?.category_emoji).toBe("shopping-cart");
    // Explicit guard — ensures we catch a leak even if "Supermercado" changes.
    expect(row?.category_name).not.toBe("USER_B_MERCADO_NAME");
    expect(row?.category_emoji).not.toBe("USER_B_MERCADO_ICON");
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("recentTxHandler — errors", () => {
  it("returns 422 invalid_params when size is S", async () => {
    const res = await recentTxHandler(makeCtx({ userId: USER_A, size: "S" }));
    expect(res.status).toBe(422);
    expect((res.body as ErrorBody).error.code).toBe("invalid_params");
  });
});

// ---------------------------------------------------------------------------
// FX conversion (USD → COP at current TRM)
// ---------------------------------------------------------------------------

describe("recentTxHandler — USD conversion", () => {
  it("converts USD txs to COP at the current FX rate, preserving sign", async () => {
    // -$25 USD @ TRM 4000 = -100.000 COP.
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_USD,
      occurredAt: T2,
      amountCents: -25_00,
      currency: "USD",
      merchant: "amazon",
    });
    const res = await recentTxHandler(makeCtx({ userId: USER_A, size: "L" }));
    const body = res.body as SuccessBody;
    expect(body.data.transactions).toHaveLength(1);
    expect(body.data.transactions[0]?.amount_cop).toBe(-100_000);
  });
});

// ---------------------------------------------------------------------------
// Missing category (orphan slug) — tx still returned, null cat fields
// ---------------------------------------------------------------------------

describe("recentTxHandler — missing category", () => {
  // The FK `transactions_user_category_fk` blocks a tx from pointing at a
  // slug that has no row at all. The real-world "orphan" we care about is
  // when a category gets archived AFTER the tx was classified — the row
  // still exists (so the FK holds) but the JOIN filters it out via
  // `notDeleted`. We reproduce that state here, then restore the category
  // at the end so downstream tests (if any) see a clean slate.
  const ORPHAN_SLUG = "__widget_recent_tx_orphan";

  beforeAll(async () => {
    await db.insert(categories).values({
      userId: USER_A,
      slug: ORPHAN_SLUG,
      name: "Orphan",
      icon: "trash",
    });
  });

  afterAll(async () => {
    await db
      .delete(categories)
      .where(and(eq(categories.userId, USER_A), eq(categories.slug, ORPHAN_SLUG)));
  });

  it("returns null category fields when the slug points at an archived (soft-deleted) category", async () => {
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: T2,
      amountCents: -10_000_00,
      merchant: "unknown cat",
      categorySlug: ORPHAN_SLUG,
    });
    // Soft-delete the category — the JOIN filters on `notDeleted`, so the
    // tx should come back with null category name/emoji but still render.
    await db
      .update(categories)
      .set({ deletedAt: new Date() })
      .where(and(eq(categories.userId, USER_A), eq(categories.slug, ORPHAN_SLUG)));

    try {
      const res = await recentTxHandler(makeCtx({ userId: USER_A, size: "L" }));
      const body = res.body as SuccessBody;
      expect(body.data.transactions).toHaveLength(1);
      expect(body.data.transactions[0]?.category_name).toBeNull();
      expect(body.data.transactions[0]?.category_emoji).toBeNull();
      expect(body.data.transactions[0]?.merchant).toBe("unknown cat");
    } finally {
      // Restore so afterAll can DELETE the row without FK drama.
      await db
        .update(categories)
        .set({ deletedAt: null })
        .where(and(eq(categories.userId, USER_A), eq(categories.slug, ORPHAN_SLUG)));
    }
  });
});

// ---------------------------------------------------------------------------
// Account label — formatAccountLabel output
// ---------------------------------------------------------------------------

describe("recentTxHandler — account label", () => {
  it("uses formatAccountLabel for account_label (name + currency)", async () => {
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: T2,
      amountCents: -10_000_00,
      merchant: "cop tx",
    });
    const res = await recentTxHandler(makeCtx({ userId: USER_A, size: "L" }));
    const body = res.body as SuccessBody;
    expect(body.data.transactions).toHaveLength(1);
    // `formatAccountLabel` default output is `${name} (${currency})`.
    expect(body.data.transactions[0]?.account_label).toBe(`${MARKER}-a-cop (COP)`);
  });

  it("account_label reflects the tx's account currency (USD vs COP)", async () => {
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_USD,
      occurredAt: T2,
      amountCents: -10_00,
      currency: "USD",
      merchant: "usd tx",
    });
    const res = await recentTxHandler(makeCtx({ userId: USER_A, size: "L" }));
    const body = res.body as SuccessBody;
    expect(body.data.transactions[0]?.account_label).toBe(`${MARKER}-a-usd (USD)`);
  });
});
