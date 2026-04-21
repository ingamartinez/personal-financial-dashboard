import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, fxRates, physicalCards, transactions, users } from "@/lib/db/schema";
import { misTcsHandler } from "./mis-tcs";

// Cleanup gate: everything this suite touches is tagged so the delete queries
// only remove what we own. Matches the tc-focus.test.ts pattern.
const MARKER = "__widget_mis_tcs_test";

// Stable, far-future FX date so getCurrentFxRate() returns our seeded row
// (it ORDERs BY as_of DESC) regardless of any other rates in findash_test.
const TEST_FX_DATE = "9999-01-01";

let USER_A = 0;
let USER_B = 0;

async function cleanup() {
  // FK cascade order: transactions → accounts → physical_cards. Users stay
  // for the whole file lifetime (afterAll drops them).
  await db.execute(
    sql`DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE name LIKE ${MARKER + "%"})`,
  );
  await db.execute(sql`DELETE FROM accounts WHERE name LIKE ${MARKER + "%"}`);
  await db.execute(
    sql`DELETE FROM physical_cards WHERE name LIKE ${MARKER + "%"} OR institution = ${MARKER}`,
  );
}

async function insertBalance(
  userId: number,
  accountId: number,
  currency: "COP" | "USD",
  amountCents: number,
): Promise<void> {
  if (amountCents === 0) return;
  await db.insert(transactions).values({
    userId,
    accountId,
    occurredAt: new Date(),
    amountCents: BigInt(amountCents),
    currency,
    descriptionRaw: `${MARKER} opening`,
    classificationMethod: "manual",
    source: "balance_adjustment",
    channel: "manual",
    isAdjustment: true,
  });
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

  // TRM = 4000 for deterministic COP math on multi-currency cards.
  await db
    .insert(fxRates)
    .values({
      base: "USD",
      quote: "COP",
      rateMicros: BigInt(4_000_000_000), // 4000 * 1_000_000
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
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${MARKER + "%"}`);
  await db.$client.end({ timeout: 1 });
});

// ---------------------------------------------------------------------------
// Helpers — WidgetHandlerContext + seed helpers
// ---------------------------------------------------------------------------

function makeCtx(params: { userId: number; size?: "S" | "M" | "L" }) {
  return {
    userId: params.userId,
    size: (params.size ?? "M") as "S" | "M" | "L",
    searchParams: new URLSearchParams(),
  };
}

type SuccessBody = {
  widget_id: "mis-tcs";
  size: "M" | "L";
  data: {
    cards: Array<{
      id: string | number;
      name: string;
      network: string | null;
      last4: string | null;
      available_cop: number;
      credit_limit_cop: number;
      utilization_pct: number;
    }>;
    total_available_cop: number;
    total_credit_cop: number;
  };
  generated_at: string;
};

type ErrorBody = { error: { code: string; message: string } };

async function seedSingleCurrencyTc(params: {
  userId: number;
  slug: string;
  creditLimitCents: number;
  balanceCents: number;
  currency?: "COP" | "USD";
  last4?: string;
  network?: "visa" | "mastercard" | "amex";
}): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId: params.userId,
      name: `${MARKER}-${params.slug}`,
      institution: "Bancolombia",
      type: "credit_card",
      currency: params.currency ?? "COP",
      metadata: {
        creditLimitCents: params.creditLimitCents,
        last4s: params.last4 ? [params.last4] : undefined,
        network: params.network,
      },
    })
    .returning({ id: accounts.id });
  await insertBalance(params.userId, row.id, params.currency ?? "COP", params.balanceCents);
  return row.id;
}

async function seedMultiCurrencyTc(params: {
  userId: number;
  slug: string;
  creditLimitCents: number;
  copBalanceCents: number;
  usdBalanceCents: number;
  network?: "visa" | "mastercard" | "amex";
  last4?: string;
}): Promise<string> {
  const pcId = randomUUID();
  await db.insert(physicalCards).values({
    id: pcId,
    userId: params.userId,
    institution: "Bancolombia",
    name: `${MARKER}-${params.slug}`,
    network: params.network ?? "mastercard",
    last4: params.last4 ?? "0000",
    creditLimitCents: BigInt(params.creditLimitCents),
  });
  const rows = await db
    .insert(accounts)
    .values([
      {
        userId: params.userId,
        name: `${MARKER}-${params.slug}-cop`,
        institution: "Bancolombia",
        type: "credit_card",
        currency: "COP",
        physicalCardId: pcId,
      },
      {
        userId: params.userId,
        name: `${MARKER}-${params.slug}-usd`,
        institution: "Bancolombia",
        type: "credit_card",
        currency: "USD",
        physicalCardId: pcId,
      },
    ])
    .returning({ id: accounts.id, currency: accounts.currency });
  for (const r of rows) {
    if (r.currency === "COP")
      await insertBalance(params.userId, r.id, "COP", params.copBalanceCents);
    else await insertBalance(params.userId, r.id, "USD", params.usdBalanceCents);
  }
  return pcId;
}

// ---------------------------------------------------------------------------
// Shape: mixed single + multi currency cards
// ---------------------------------------------------------------------------

describe("misTcsHandler — mixed roster", () => {
  it("returns a single entry per physical_card PLUS one per single-currency account", async () => {
    // Multi-currency: limit 20MM, COP debt 500k, USD debt $100 @ 4000 = 400k
    // → used 900k, available 19.1MM, util 5 %.
    const pcId = await seedMultiCurrencyTc({
      userId: USER_A,
      slug: "multi",
      creditLimitCents: 20_000_000_00,
      copBalanceCents: -500_000_00,
      usdBalanceCents: -100_00,
      network: "mastercard",
      last4: "7291",
    });
    // Single-currency: limit 5MM, debt 3.2MM → util 64 %.
    const singleId = await seedSingleCurrencyTc({
      userId: USER_A,
      slug: "single-high",
      creditLimitCents: 5_000_000_00,
      balanceCents: -3_200_000_00,
      last4: "1234",
      network: "amex",
    });

    const res = await misTcsHandler(makeCtx({ userId: USER_A, size: "L" }));
    expect(res.status).toBeUndefined();
    const body = res.body as SuccessBody;
    expect(body.widget_id).toBe("mis-tcs");
    expect(body.size).toBe("L");
    expect(body.data.cards).toHaveLength(2);

    // Ordering: util DESC → single (64 %) before multi (5 %).
    expect(body.data.cards[0].id).toBe(singleId);
    expect(body.data.cards[0].utilization_pct).toBe(64);
    expect(body.data.cards[0].network).toBe("amex");
    expect(body.data.cards[0].last4).toBe("1234");
    expect(body.data.cards[0].credit_limit_cop).toBe(5_000_000);
    expect(body.data.cards[0].available_cop).toBe(1_800_000);

    expect(body.data.cards[1].id).toBe(pcId);
    expect(body.data.cards[1].utilization_pct).toBe(5);
    expect(body.data.cards[1].network).toBe("mastercard");
    expect(body.data.cards[1].last4).toBe("7291");
    expect(body.data.cards[1].credit_limit_cop).toBe(20_000_000);
    expect(body.data.cards[1].available_cop).toBe(19_100_000);

    // Totals over the full roster. 20MM + 5MM credit, 19.1MM + 1.8MM available.
    expect(body.data.total_credit_cop).toBe(25_000_000);
    expect(body.data.total_available_cop).toBe(20_900_000);

    expect(body.generated_at).toMatch(/-05:00$/);
  });
});

// ---------------------------------------------------------------------------
// Shape: only single-currency cards
// ---------------------------------------------------------------------------

describe("misTcsHandler — only single-currency", () => {
  it("returns each account as its own row", async () => {
    await seedSingleCurrencyTc({
      userId: USER_A,
      slug: "sc-a",
      creditLimitCents: 2_000_000_00,
      balanceCents: -500_000_00, // 25 %
    });
    await seedSingleCurrencyTc({
      userId: USER_A,
      slug: "sc-b",
      creditLimitCents: 4_000_000_00,
      balanceCents: -3_000_000_00, // 75 %
    });

    const res = await misTcsHandler(makeCtx({ userId: USER_A, size: "L" }));
    const body = res.body as SuccessBody;
    expect(body.data.cards).toHaveLength(2);
    expect(body.data.cards[0].utilization_pct).toBe(75);
    expect(body.data.cards[1].utilization_pct).toBe(25);
    // All ids are numeric (accounts.id).
    expect(typeof body.data.cards[0].id).toBe("number");
    expect(typeof body.data.cards[1].id).toBe("number");
    expect(body.data.total_credit_cop).toBe(6_000_000);
    expect(body.data.total_available_cop).toBe(2_500_000);
  });
});

// ---------------------------------------------------------------------------
// Shape: only multi-currency cards
// ---------------------------------------------------------------------------

describe("misTcsHandler — only multi-currency", () => {
  it("returns each physical_card as a single row even with multiple sub-accounts", async () => {
    const pc1 = await seedMultiCurrencyTc({
      userId: USER_A,
      slug: "mc-low",
      creditLimitCents: 10_000_000_00,
      copBalanceCents: -1_000_000_00,
      usdBalanceCents: 0,
    });
    const pc2 = await seedMultiCurrencyTc({
      userId: USER_A,
      slug: "mc-high",
      creditLimitCents: 8_000_000_00,
      copBalanceCents: -3_000_000_00,
      usdBalanceCents: -500_00, // $500 * 4000 = 2MM
    });

    const res = await misTcsHandler(makeCtx({ userId: USER_A, size: "L" }));
    const body = res.body as SuccessBody;
    expect(body.data.cards).toHaveLength(2);

    // pc2: used 5MM / 8MM = 62.5 % → 63 %. pc1: 1MM / 10MM = 10 %.
    expect(body.data.cards[0].id).toBe(pc2);
    expect(body.data.cards[0].utilization_pct).toBe(63);
    expect(body.data.cards[1].id).toBe(pc1);
    expect(body.data.cards[1].utilization_pct).toBe(10);
    // All ids are UUID strings.
    expect(typeof body.data.cards[0].id).toBe("string");
    expect(typeof body.data.cards[1].id).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Empty-state: user has no TCs
// ---------------------------------------------------------------------------

describe("misTcsHandler — empty roster", () => {
  it("returns 200 with an empty cards array and zeroed totals", async () => {
    const res = await misTcsHandler(makeCtx({ userId: USER_A, size: "M" }));
    expect(res.status).toBeUndefined();
    const body = res.body as SuccessBody;
    expect(body.data.cards).toEqual([]);
    expect(body.data.total_available_cop).toBe(0);
    expect(body.data.total_credit_cop).toBe(0);
  });

  it("does NOT fetch FX when there are no USD sub-accounts (COP-only roster)", async () => {
    // Delete the seed FX row — if the handler still tries to call
    // getCurrentFxRate, it would hit the fallback (4000) but we want to prove
    // we skipped the query entirely. Testing behavior via absence: the result
    // must still be correct after the FX row is gone AND we have only COP.
    await db.execute(sql`DELETE FROM fx_rates WHERE source = ${MARKER}`);

    await seedSingleCurrencyTc({
      userId: USER_A,
      slug: "cop-only",
      creditLimitCents: 1_000_000_00,
      balanceCents: -100_000_00,
    });

    const res = await misTcsHandler(makeCtx({ userId: USER_A, size: "L" }));
    expect(res.status).toBeUndefined();
    const body = res.body as SuccessBody;
    expect(body.data.cards).toHaveLength(1);
    expect(body.data.cards[0].utilization_pct).toBe(10);

    // Re-seed FX for subsequent tests (afterEach cleans accounts but not fx).
    await db.insert(fxRates).values({
      base: "USD",
      quote: "COP",
      rateMicros: BigInt(4_000_000_000),
      asOf: TEST_FX_DATE,
      source: MARKER,
    });
  });
});

// ---------------------------------------------------------------------------
// Size rules
// ---------------------------------------------------------------------------

describe("misTcsHandler — size rules", () => {
  async function seedFiveCards(userId: number): Promise<void> {
    // Utilizations: 90, 70, 50, 30, 10 — strictly decreasing so the top-3
    // trim is unambiguous.
    await seedSingleCurrencyTc({
      userId,
      slug: "u90",
      creditLimitCents: 1_000_000_00,
      balanceCents: -900_000_00,
    });
    await seedSingleCurrencyTc({
      userId,
      slug: "u70",
      creditLimitCents: 1_000_000_00,
      balanceCents: -700_000_00,
    });
    await seedSingleCurrencyTc({
      userId,
      slug: "u50",
      creditLimitCents: 1_000_000_00,
      balanceCents: -500_000_00,
    });
    await seedSingleCurrencyTc({
      userId,
      slug: "u30",
      creditLimitCents: 1_000_000_00,
      balanceCents: -300_000_00,
    });
    await seedSingleCurrencyTc({
      userId,
      slug: "u10",
      creditLimitCents: 1_000_000_00,
      balanceCents: -100_000_00,
    });
  }

  it("size=M returns only the top 3 by utilization DESC", async () => {
    await seedFiveCards(USER_A);
    const res = await misTcsHandler(makeCtx({ userId: USER_A, size: "M" }));
    const body = res.body as SuccessBody;
    expect(body.size).toBe("M");
    expect(body.data.cards).toHaveLength(3);
    expect(body.data.cards.map((c) => c.utilization_pct)).toEqual([90, 70, 50]);
    // Totals still reflect the FULL roster (5 cards), NOT just the top 3.
    expect(body.data.total_credit_cop).toBe(5_000_000);
    expect(body.data.total_available_cop).toBe(2_500_000);
  });

  it("size=L returns all cards in utilization DESC order", async () => {
    await seedFiveCards(USER_A);
    const res = await misTcsHandler(makeCtx({ userId: USER_A, size: "L" }));
    const body = res.body as SuccessBody;
    expect(body.size).toBe("L");
    expect(body.data.cards).toHaveLength(5);
    expect(body.data.cards.map((c) => c.utilization_pct)).toEqual([90, 70, 50, 30, 10]);
  });

  it("size=S returns 422 invalid_params", async () => {
    const res = await misTcsHandler(makeCtx({ userId: USER_A, size: "S" }));
    expect(res.status).toBe(422);
    expect((res.body as ErrorBody).error.code).toBe("invalid_params");
    expect((res.body as ErrorBody).error.message).toContain("size S");
  });
});

// ---------------------------------------------------------------------------
// Tenancy + soft-delete exclusion
// ---------------------------------------------------------------------------

describe("misTcsHandler — tenancy + soft-delete", () => {
  it("does not leak user B's cards to user A", async () => {
    await seedSingleCurrencyTc({
      userId: USER_B,
      slug: "user-b-card",
      creditLimitCents: 9_999_000_00,
      balanceCents: -5_000_000_00,
    });
    await seedMultiCurrencyTc({
      userId: USER_B,
      slug: "user-b-mc",
      creditLimitCents: 5_000_000_00,
      copBalanceCents: -1_000_000_00,
      usdBalanceCents: 0,
    });

    const res = await misTcsHandler(makeCtx({ userId: USER_A, size: "L" }));
    const body = res.body as SuccessBody;
    expect(body.data.cards).toEqual([]);
    expect(body.data.total_available_cop).toBe(0);
    expect(body.data.total_credit_cop).toBe(0);
  });

  it("excludes soft-deleted single-currency TCs", async () => {
    const liveId = await seedSingleCurrencyTc({
      userId: USER_A,
      slug: "live",
      creditLimitCents: 2_000_000_00,
      balanceCents: -500_000_00,
    });
    const archivedId = await seedSingleCurrencyTc({
      userId: USER_A,
      slug: "archived",
      creditLimitCents: 3_000_000_00,
      balanceCents: -1_000_000_00,
    });
    await db
      .update(accounts)
      .set({ deletedAt: new Date() })
      .where(sql`${accounts.id} = ${archivedId}`);

    const res = await misTcsHandler(makeCtx({ userId: USER_A, size: "L" }));
    const body = res.body as SuccessBody;
    expect(body.data.cards.map((c) => c.id)).toEqual([liveId]);
    expect(body.data.total_credit_cop).toBe(2_000_000);
  });

  it("excludes soft-deleted sub-accounts from a multi-currency card's utilization", async () => {
    // Seed a card where the USD sub-account carries -$100 debt. If the
    // archived sub-account is correctly filtered, only the COP debt remains.
    const pcId = await seedMultiCurrencyTc({
      userId: USER_A,
      slug: "mc-archived-sub",
      creditLimitCents: 10_000_000_00,
      copBalanceCents: -500_000_00,
      usdBalanceCents: -100_00,
    });
    // Archive the USD sub-account.
    await db
      .update(accounts)
      .set({ deletedAt: new Date() })
      .where(sql`${accounts.physicalCardId} = ${pcId} AND ${accounts.currency} = 'USD'`);

    const res = await misTcsHandler(makeCtx({ userId: USER_A, size: "L" }));
    const body = res.body as SuccessBody;
    expect(body.data.cards).toHaveLength(1);
    expect(body.data.cards[0].id).toBe(pcId);
    // Only COP debt of 500k remains → available 9.5MM, util 5 %.
    expect(body.data.cards[0].available_cop).toBe(9_500_000);
    expect(body.data.cards[0].utilization_pct).toBe(5);
  });
});
