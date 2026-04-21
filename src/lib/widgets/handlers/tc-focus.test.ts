import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, fxRates, physicalCards, transactions, users } from "@/lib/db/schema";
import { tcFocusHandler, computeNextCutoff } from "./tc-focus";

// Everything this file inserts is tagged with MARKER so the cleanup queries
// only delete what this suite owns.
const MARKER = "__widget_tc_focus_test";

// `getCurrentFxRate()` orders by `as_of DESC`, so to guarantee our deterministic
// rate wins over any residual row in `findash_test`, seed with a far-future
// date. We scope by `source = MARKER` so cleanup only removes what we own.
const TEST_FX_DATE = "9999-01-01";

let USER_A = 0;
let USER_B = 0;

async function cleanup() {
  // Txs (FK RESTRICT) → accounts → physical_cards → users (handled in afterAll).
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

  // Seed a deterministic TRM of 4000 so tests can assert exact COP values.
  // The handler reads getCurrentFxRate() which returns the most-recent row;
  // using a past `as_of` keeps this seed stable across runs that may have
  // newer production rates.
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
// Helpers — build the WidgetHandlerContext
// ---------------------------------------------------------------------------

function makeCtx(params: { userId: number; size?: "S" | "M" | "L"; target?: string | null }) {
  const search = new URLSearchParams();
  if (params.target !== null && params.target !== undefined) {
    search.set("target", params.target);
  }
  return {
    userId: params.userId,
    size: (params.size ?? "S") as "S" | "M" | "L",
    searchParams: search,
  };
}

type SuccessBody = {
  widget_id: "tc-focus";
  size: "S";
  data: {
    card_name: string;
    network: string | null;
    last4: string | null;
    credit_limit_cop: number;
    used_cop: number;
    available_cop: number;
    utilization_pct: number;
    next_statement_cutoff: string | null;
    days_to_cutoff: number | null;
  };
  generated_at: string;
};

type ErrorBody = { error: { code: string; message: string } };

// ---------------------------------------------------------------------------
// Single-currency TC — target is accounts.id (integer)
// ---------------------------------------------------------------------------

describe("tcFocusHandler — single-currency TC", () => {
  async function seedSingleCurrencyTc(params: {
    userId: number;
    creditLimitCents: number;
    balanceCents: number;
    cutoffDay?: number;
    last4?: string;
    network?: "visa" | "mastercard" | "amex";
  }): Promise<number> {
    const [row] = await db
      .insert(accounts)
      .values({
        userId: params.userId,
        name: `${MARKER}-single-currency-tc`,
        institution: "Bancolombia",
        type: "credit_card",
        currency: "COP",
        metadata: {
          creditLimitCents: params.creditLimitCents,
          cutoffDay: params.cutoffDay,
          last4s: params.last4 ? [params.last4] : undefined,
          network: params.network,
        },
      })
      .returning({ id: accounts.id });
    await insertBalance(params.userId, row.id, "COP", params.balanceCents);
    return row.id;
  }

  it("returns cupo + utilization for a single-currency TC", async () => {
    // Limit 5.000.000 COP, balance -3.200.000 COP → used 3.200.000, available 1.800.000.
    // Utilization = 64 %.
    const id = await seedSingleCurrencyTc({
      userId: USER_A,
      creditLimitCents: 5_000_000_00,
      balanceCents: -3_200_000_00,
      cutoffDay: 3,
      last4: "1234",
      network: "amex",
    });

    const res = await tcFocusHandler(makeCtx({ userId: USER_A, target: String(id) }));
    expect(res.status).toBeUndefined(); // default 200
    const body = res.body as SuccessBody;
    expect(body.widget_id).toBe("tc-focus");
    expect(body.size).toBe("S");
    expect(body.data.network).toBe("amex");
    expect(body.data.last4).toBe("1234");
    expect(body.data.credit_limit_cop).toBe(5_000_000);
    expect(body.data.used_cop).toBe(3_200_000);
    expect(body.data.available_cop).toBe(1_800_000);
    expect(body.data.utilization_pct).toBe(64);
    // card_name uses formatAccountLabel — "<name> (<currency>)"
    expect(body.data.card_name).toContain(MARKER);
    expect(body.data.card_name).toContain("(COP)");
    // Both fields populated for a cutoffDay=3 setup; exact day count depends
    // on "today" which we assert below in the dedicated cutoff tests.
    expect(body.data.next_statement_cutoff).toMatch(/^\d{4}-\d{2}-03$/);
    expect(typeof body.data.days_to_cutoff).toBe("number");
    expect(body.generated_at).toMatch(/-05:00$/);
  });

  it("returns 0 utilization and full available when balance is zero", async () => {
    const id = await seedSingleCurrencyTc({
      userId: USER_A,
      creditLimitCents: 10_000_000_00,
      balanceCents: 0,
    });
    const res = await tcFocusHandler(makeCtx({ userId: USER_A, target: String(id) }));
    const body = res.body as SuccessBody;
    expect(body.data.used_cop).toBe(0);
    expect(body.data.available_cop).toBe(10_000_000);
    expect(body.data.utilization_pct).toBe(0);
  });

  it("rounds utilization to the nearest integer percent", async () => {
    // limit 3.000.000, used 1.000.000 → 33.333...% → round to 33
    const id = await seedSingleCurrencyTc({
      userId: USER_A,
      creditLimitCents: 3_000_000_00,
      balanceCents: -1_000_000_00,
    });
    const res = await tcFocusHandler(makeCtx({ userId: USER_A, target: String(id) }));
    const body = res.body as SuccessBody;
    expect(body.data.utilization_pct).toBe(33);
    expect(Number.isInteger(body.data.utilization_pct)).toBe(true);
  });

  it("returns null cutoff fields when metadata.cutoffDay is missing", async () => {
    const id = await seedSingleCurrencyTc({
      userId: USER_A,
      creditLimitCents: 1_000_000_00,
      balanceCents: -100_000_00,
    });
    const res = await tcFocusHandler(makeCtx({ userId: USER_A, target: String(id) }));
    const body = res.body as SuccessBody;
    expect(body.data.next_statement_cutoff).toBeNull();
    expect(body.data.days_to_cutoff).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Multi-currency TC — target is physical_cards.id (uuid)
// ---------------------------------------------------------------------------

describe("tcFocusHandler — multi-currency TC", () => {
  it("returns cupo + utilization for a physical_card with linked accounts", async () => {
    const pcId = randomUUID();
    await db.insert(physicalCards).values({
      id: pcId,
      userId: USER_A,
      institution: "Bancolombia",
      name: `${MARKER}-mc`,
      network: "mastercard",
      last4: "7291",
      creditLimitCents: BigInt(20_000_000_00),
      statementCutoffDay: 15,
    });
    // Sub-accounts: COP -500.000, USD -$100 @ TRM 4000 → used = 500k + 400k = 900k
    const rows = await db
      .insert(accounts)
      .values([
        {
          userId: USER_A,
          name: `${MARKER}-mc-cop`,
          institution: "Bancolombia",
          type: "credit_card",
          currency: "COP",
          physicalCardId: pcId,
        },
        {
          userId: USER_A,
          name: `${MARKER}-mc-usd`,
          institution: "Bancolombia",
          type: "credit_card",
          currency: "USD",
          physicalCardId: pcId,
        },
      ])
      .returning({ id: accounts.id, currency: accounts.currency });
    for (const r of rows) {
      if (r.currency === "COP") await insertBalance(USER_A, r.id, "COP", -500_000_00);
      else await insertBalance(USER_A, r.id, "USD", -100_00);
    }

    const res = await tcFocusHandler(makeCtx({ userId: USER_A, target: pcId }));
    const body = res.body as SuccessBody;
    expect(body.data.credit_limit_cop).toBe(20_000_000);
    expect(body.data.network).toBe("mastercard");
    expect(body.data.last4).toBe("7291");
    // used = 500k COP + $100 * 4000 = 900.000 COP → available = 19.100.000
    expect(body.data.used_cop).toBe(900_000);
    expect(body.data.available_cop).toBe(19_100_000);
    // 900k / 20MM = 4.5 % → rounds to 5
    expect(body.data.utilization_pct).toBe(5);
    // physicalCard.name used as card_name
    expect(body.data.card_name).toContain(MARKER);
    expect(body.data.next_statement_cutoff).toMatch(/^\d{4}-\d{2}-15$/);
  });
});

// ---------------------------------------------------------------------------
// Error paths — target missing, bogus, cross-tenant, wrong type, size.
// ---------------------------------------------------------------------------

describe("tcFocusHandler — errors", () => {
  it("returns 422 invalid_params when target is missing", async () => {
    const res = await tcFocusHandler(makeCtx({ userId: USER_A, target: null }));
    expect(res.status).toBe(422);
    expect((res.body as ErrorBody).error.code).toBe("invalid_params");
  });

  it("returns 404 target_not_found for a random UUID that doesn't exist", async () => {
    const fake = randomUUID();
    const res = await tcFocusHandler(makeCtx({ userId: USER_A, target: fake }));
    expect(res.status).toBe(404);
    expect((res.body as ErrorBody).error.code).toBe("target_not_found");
  });

  it("returns 404 for a credit_card account that belongs to another user (tenancy)", async () => {
    const [row] = await db
      .insert(accounts)
      .values({
        userId: USER_B,
        name: `${MARKER}-tenant-other`,
        institution: "Bancolombia",
        type: "credit_card",
        currency: "COP",
        metadata: { creditLimitCents: 1_000_000_00 },
      })
      .returning({ id: accounts.id });

    const res = await tcFocusHandler(makeCtx({ userId: USER_A, target: String(row.id) }));
    expect(res.status).toBe(404);
    expect((res.body as ErrorBody).error.code).toBe("target_not_found");
  });

  it("returns 404 for a physical_card that belongs to another user (tenancy)", async () => {
    const pcId = randomUUID();
    await db.insert(physicalCards).values({
      id: pcId,
      userId: USER_B,
      institution: "Bancolombia",
      name: `${MARKER}-tenant-pc`,
      creditLimitCents: BigInt(1_000_000_00),
    });

    const res = await tcFocusHandler(makeCtx({ userId: USER_A, target: pcId }));
    expect(res.status).toBe(404);
    expect((res.body as ErrorBody).error.code).toBe("target_not_found");
  });

  it("returns 404 when target is a non-credit_card account (e.g. savings)", async () => {
    const [row] = await db
      .insert(accounts)
      .values({
        userId: USER_A,
        name: `${MARKER}-savings`,
        institution: "Bancolombia",
        type: "savings",
        currency: "COP",
      })
      .returning({ id: accounts.id });

    const res = await tcFocusHandler(makeCtx({ userId: USER_A, target: String(row.id) }));
    expect(res.status).toBe(404);
    expect((res.body as ErrorBody).error.code).toBe("target_not_found");
  });

  it("returns 422 invalid_params when size is M", async () => {
    const res = await tcFocusHandler(makeCtx({ userId: USER_A, size: "M", target: "1" }));
    expect(res.status).toBe(422);
    expect((res.body as ErrorBody).error.code).toBe("invalid_params");
  });

  it("returns 422 invalid_params when size is L", async () => {
    const res = await tcFocusHandler(makeCtx({ userId: USER_A, size: "L", target: "1" }));
    expect(res.status).toBe(422);
    expect((res.body as ErrorBody).error.code).toBe("invalid_params");
  });

  it("returns 404 for garbage target strings (non-uuid, non-integer)", async () => {
    const res = await tcFocusHandler(makeCtx({ userId: USER_A, target: "not-a-thing" }));
    expect(res.status).toBe(404);
    expect((res.body as ErrorBody).error.code).toBe("target_not_found");
  });
});

// ---------------------------------------------------------------------------
// computeNextCutoff — pure unit tests. Exercises the two branches (this-month
// vs next-month) and the clamp to short months.
// ---------------------------------------------------------------------------

describe("computeNextCutoff", () => {
  it("picks the current month when cutoffDay is later than today", () => {
    // Today is 2026-04-21 Bogota. cutoff=25 → next is 2026-04-25, 4 days away.
    const res = computeNextCutoff(25, { year: 2026, month: 4, day: 21 });
    expect(res.next).toBe("2026-04-25");
    expect(res.daysTo).toBe(4);
  });

  it("picks next month when cutoffDay is today or earlier", () => {
    const res = computeNextCutoff(15, { year: 2026, month: 4, day: 20 });
    expect(res.next).toBe("2026-05-15");
    expect(res.daysTo).toBe(25);
  });

  it("treats cutoff == today as next month (cutoff is in the future)", () => {
    // When today.day === cutoffDay, the cutoff already fired, so next is
    // the same day in the following month.
    const res = computeNextCutoff(10, { year: 2026, month: 4, day: 10 });
    expect(res.next).toBe("2026-05-10");
    expect(res.daysTo).toBe(30);
  });

  it("wraps December → January with year +1", () => {
    const res = computeNextCutoff(5, { year: 2026, month: 12, day: 20 });
    expect(res.next).toBe("2027-01-05");
    expect(res.daysTo).toBe(16);
  });

  it("clamps cutoffDay=31 to the last day of a 30-day target month", () => {
    // Today 2026-03-31, cutoff=31 → fires again in April. April has 30 days,
    // so the clamp lands on 2026-04-30 (30 days away).
    const res = computeNextCutoff(31, { year: 2026, month: 3, day: 31 });
    expect(res.next).toBe("2026-04-30");
    expect(res.daysTo).toBe(30);
  });

  it("clamps cutoffDay=31 to Feb-28 in a non-leap year", () => {
    const res = computeNextCutoff(31, { year: 2026, month: 1, day: 31 });
    expect(res.next).toBe("2026-02-28");
    expect(res.daysTo).toBe(28);
  });
});
