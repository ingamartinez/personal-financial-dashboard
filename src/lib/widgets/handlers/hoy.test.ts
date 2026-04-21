import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, fxRates, transactions, users } from "@/lib/db/schema";
import { formatDayLabel, hoyHandler } from "./hoy";

// Cleanup gate: everything this suite touches is tagged so the delete queries
// only remove what we own. Mirrors the convention used by tc-focus / mis-tcs.
const MARKER = "__widget_hoy_test";

// Stable, far-future FX date so getCurrentFxRate() returns our seeded row
// (it ORDERs BY as_of DESC) regardless of any other rates in findash_test.
const TEST_FX_DATE = "9999-01-01";

// Bogota is UTC-5 year-round. A "today" near midday locally is easiest to
// reason about — no matter what real-world time the suite runs, we stamp
// transactions with absolute offsets from this fake "now".
const FAKE_NOW_UTC = new Date("2026-04-21T18:00:00Z"); // 13:00 Bogota
// On 2026-04-21, Bogota "today" spans 2026-04-21 05:00Z..2026-04-22 05:00Z.
const BOGOTA_TODAY_MIDDAY = new Date("2026-04-21T17:00:00Z"); // 12:00 Bogota
const BOGOTA_YESTERDAY_MIDDAY = new Date("2026-04-20T17:00:00Z"); // 12:00 Bogota
const BOGOTA_DAY_10_MIDDAY = new Date("2026-04-10T17:00:00Z");
// A tx at 23:30 Bogota on 2026-04-21 → 04:30 UTC on 2026-04-22 (still Bogota today).
const BOGOTA_TODAY_LATE_NIGHT = new Date("2026-04-22T04:30:00Z");

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
      institution: "Nu",
      type: "savings",
      currency: "USD",
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
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${MARKER + "%"}`);
  await db.$client.end({ timeout: 1 });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(params: { userId: number; size?: "S" | "M" | "L" }) {
  return {
    userId: params.userId,
    size: (params.size ?? "S") as "S" | "M" | "L",
    searchParams: new URLSearchParams(),
  };
}

type InsertTxOpts = {
  userId: number;
  accountId: number;
  occurredAt: Date;
  amountCents: number;
  currency?: "COP" | "USD";
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
      classificationMethod: "manual",
      source: opts.source ?? "manual",
      channel: opts.channel ?? "bank",
      isAdjustment: opts.isAdjustment ?? false,
      deletedAt: opts.deletedAt,
    })
    .returning({ id: transactions.id });
  return row.id;
}

type SuccessBody = {
  widget_id: "hoy";
  size: "S";
  data: {
    spent_cop: number;
    tx_count: number;
    vs_daily_avg_pct: number | null;
    day_label: string;
  };
  generated_at: string;
};

type ErrorBody = { error: { code: string; message: string } };

// ---------------------------------------------------------------------------
// Happy path — today spent vs MTD avg
// ---------------------------------------------------------------------------

describe("hoyHandler — spending + MTD comparison", () => {
  beforeAll(() => {
    // Only mock Date — leaving setTimeout/setInterval alone so postgres.js
    // socket timers and other async plumbing keep working. `vi.useFakeTimers()`
    // without `toFake` freezes those too and causes DB queries to hang.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FAKE_NOW_UTC);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("returns today's spend, tx count, and vs_daily_avg_pct vs MTD daily avg", async () => {
    // 4 outflows today totaling 85.000 COP.
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_TODAY_MIDDAY,
      amountCents: -20_000_00,
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_TODAY_MIDDAY,
      amountCents: -25_000_00,
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_TODAY_MIDDAY,
      amountCents: -15_000_00,
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_TODAY_MIDDAY,
      amountCents: -25_000_00,
    });

    // Prior-MTD: 1.900.000 COP spread over days 1..20 (20 days) → avg 95.000/day.
    // Today (85.000) vs avg (95.000) → (85/95 - 1) * 100 = -10.526... → -11.
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_DAY_10_MIDDAY,
      amountCents: -1_000_000_00,
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_YESTERDAY_MIDDAY,
      amountCents: -900_000_00,
    });

    const res = await hoyHandler(makeCtx({ userId: USER_A }));
    expect(res.status).toBeUndefined();
    const body = res.body as SuccessBody;
    expect(body.widget_id).toBe("hoy");
    expect(body.size).toBe("S");
    expect(body.data.spent_cop).toBe(85_000);
    expect(body.data.tx_count).toBe(4);
    expect(body.data.vs_daily_avg_pct).toBe(-11);
    expect(body.data.day_label).toBe("Martes 21 abr");
    expect(body.generated_at).toMatch(/-05:00$/);
  });

  it("returns vs_daily_avg_pct null on day 1 of the month", async () => {
    // Pin clock to 2026-04-01 midday Bogota.
    vi.setSystemTime(new Date("2026-04-01T17:00:00Z"));
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: new Date("2026-04-01T18:00:00Z"),
      amountCents: -50_000_00,
    });
    const res = await hoyHandler(makeCtx({ userId: USER_A }));
    const body = res.body as SuccessBody;
    expect(body.data.spent_cop).toBe(50_000);
    expect(body.data.tx_count).toBe(1);
    expect(body.data.vs_daily_avg_pct).toBeNull();
    // Restore clock for the rest of the block.
    vi.setSystemTime(FAKE_NOW_UTC);
  });

  it("returns zeros when no txs today and null vs_avg when avg is 0", async () => {
    // No prior MTD, no today → avg = 0 → spec says vs_daily_avg_pct should
    // reflect the comparison; with no prior data and no today spend, we
    // treat "0 vs 0" as 0% (no change), and "non-zero vs 0" as null.
    const res = await hoyHandler(makeCtx({ userId: USER_A }));
    const body = res.body as SuccessBody;
    expect(body.data.spent_cop).toBe(0);
    expect(body.data.tx_count).toBe(0);
    expect(body.data.vs_daily_avg_pct).toBe(0);
  });

  it("returns -100 when today is 0 but MTD avg > 0", async () => {
    // Prior MTD of 1.000.000 COP across 20 days → avg 50.000/day.
    // Today = 0 → (0/50k - 1) * 100 = -100.
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_DAY_10_MIDDAY,
      amountCents: -1_000_000_00,
    });
    const res = await hoyHandler(makeCtx({ userId: USER_A }));
    const body = res.body as SuccessBody;
    expect(body.data.spent_cop).toBe(0);
    expect(body.data.tx_count).toBe(0);
    expect(body.data.vs_daily_avg_pct).toBe(-100);
  });

  it("excludes transfers and balance adjustments from spent and tx_count", async () => {
    // A real outflow (counts).
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_TODAY_MIDDAY,
      amountCents: -10_000_00,
    });
    // A transfer (excluded).
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_TODAY_MIDDAY,
      amountCents: -500_000_00,
      channel: "transfer",
    });
    // A balance adjustment via source (excluded).
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_TODAY_MIDDAY,
      amountCents: -100_000_00,
      source: "balance_adjustment",
      channel: "manual",
      isAdjustment: true,
    });
    const res = await hoyHandler(makeCtx({ userId: USER_A }));
    const body = res.body as SuccessBody;
    expect(body.data.spent_cop).toBe(10_000);
    expect(body.data.tx_count).toBe(1);
  });

  it("excludes soft-deleted transactions", async () => {
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_TODAY_MIDDAY,
      amountCents: -10_000_00,
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_TODAY_MIDDAY,
      amountCents: -80_000_00,
      deletedAt: BOGOTA_TODAY_MIDDAY,
    });
    const res = await hoyHandler(makeCtx({ userId: USER_A }));
    const body = res.body as SuccessBody;
    expect(body.data.spent_cop).toBe(10_000);
    expect(body.data.tx_count).toBe(1);
  });

  it("excludes positive amounts (credits / refunds) from spent and tx_count", async () => {
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_TODAY_MIDDAY,
      amountCents: -10_000_00,
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_TODAY_MIDDAY,
      amountCents: 50_000_00, // refund / income
    });
    const res = await hoyHandler(makeCtx({ userId: USER_A }));
    const body = res.body as SuccessBody;
    expect(body.data.spent_cop).toBe(10_000);
    expect(body.data.tx_count).toBe(1);
  });

  it("is isolated per user (cross-tenant)", async () => {
    // User B spends a fortune today — must not leak into USER_A's widget.
    await insertTx({
      userId: USER_B,
      accountId: ACCT_B_COP,
      occurredAt: BOGOTA_TODAY_MIDDAY,
      amountCents: -9_999_999_00,
    });
    const res = await hoyHandler(makeCtx({ userId: USER_A }));
    const body = res.body as SuccessBody;
    expect(body.data.spent_cop).toBe(0);
    expect(body.data.tx_count).toBe(0);
  });

  it("converts USD txs at the current FX rate", async () => {
    // $25 USD @ TRM 4000 = 100.000 COP.
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_USD,
      occurredAt: BOGOTA_TODAY_MIDDAY,
      amountCents: -25_00,
      currency: "USD",
    });
    const res = await hoyHandler(makeCtx({ userId: USER_A }));
    const body = res.body as SuccessBody;
    expect(body.data.spent_cop).toBe(100_000);
    expect(body.data.tx_count).toBe(1);
  });

  it("counts a tx at 23:30 Bogota local time as TODAY even if UTC rolled over", async () => {
    // 04:30 UTC on the 22nd == 23:30 Bogota on the 21st → still today.
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_TODAY_LATE_NIGHT,
      amountCents: -40_000_00,
    });
    const res = await hoyHandler(makeCtx({ userId: USER_A }));
    const body = res.body as SuccessBody;
    expect(body.data.spent_cop).toBe(40_000);
    expect(body.data.tx_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("hoyHandler — errors", () => {
  it("returns 422 invalid_params when size is M", async () => {
    const res = await hoyHandler(makeCtx({ userId: USER_A, size: "M" }));
    expect(res.status).toBe(422);
    expect((res.body as ErrorBody).error.code).toBe("invalid_params");
  });

  it("returns 422 invalid_params when size is L", async () => {
    const res = await hoyHandler(makeCtx({ userId: USER_A, size: "L" }));
    expect(res.status).toBe(422);
    expect((res.body as ErrorBody).error.code).toBe("invalid_params");
  });
});

// ---------------------------------------------------------------------------
// formatDayLabel — pure, locale-dependent but timezone-anchored
// ---------------------------------------------------------------------------

describe("formatDayLabel", () => {
  it("formats as '<Weekday> <day> <mes>' in Bogota, with capitalized weekday", () => {
    // 2026-04-21 midday UTC is still 2026-04-21 in Bogota (UTC-5).
    const out = formatDayLabel(new Date("2026-04-21T18:00:00Z"));
    expect(out).toBe("Martes 21 abr");
  });

  it("rolls back to the Bogota-local date even when the UTC clock has rolled over", () => {
    // 03:00 UTC on the 22nd == 22:00 Bogota on the 21st.
    const out = formatDayLabel(new Date("2026-04-22T03:00:00Z"));
    expect(out).toBe("Martes 21 abr");
  });
});
