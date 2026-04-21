import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, fxRates, transactions, users } from "@/lib/db/schema";
import { daysInMonth, formatMonthLabel, mesActualHandler } from "./mes-actual";

// Cleanup gate — mirrors hoy.test.ts so parallel suites don't clobber each
// other's seed rows. Everything under this prefix is fair game to delete.
const MARKER = "__widget_mes_actual_test";

const TEST_FX_DATE = "9999-01-01";

// Bogota is UTC-5, no DST. Our canonical "now" lives mid-month mid-day so the
// day-of-month and month-label math is unambiguous.
const FAKE_NOW_UTC = new Date("2026-04-21T18:00:00Z"); // 13:00 Bogota on day 21
const BOGOTA_DAY_5_MIDDAY = new Date("2026-04-05T17:00:00Z");
const BOGOTA_DAY_10_MIDDAY = new Date("2026-04-10T17:00:00Z");
const BOGOTA_TODAY_MIDDAY = new Date("2026-04-21T17:00:00Z"); // 12:00 Bogota on day 21
// Last-month (March) reference points.
const BOGOTA_MAR_5_MIDDAY = new Date("2026-03-05T17:00:00Z");
const BOGOTA_MAR_10_MIDDAY = new Date("2026-03-10T17:00:00Z");
const BOGOTA_MAR_15_MIDDAY = new Date("2026-03-15T17:00:00Z");
const BOGOTA_MAR_21_MIDDAY = new Date("2026-03-21T17:00:00Z");
const BOGOTA_MAR_22_MIDDAY = new Date("2026-03-22T17:00:00Z");

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
    size: (params.size ?? "M") as "S" | "M" | "L",
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
  widget_id: "mes-actual";
  size: "M";
  data: {
    month_label: string;
    spent_cop: number;
    day_of_month: number;
    last_month_same_day_cop: number;
    delta_pct: number | null;
    delta_direction: "up" | "down" | "flat" | null;
    projection_month_end_cop: number;
  };
  generated_at: string;
};

type ErrorBody = { error: { code: string; message: string } };

// ---------------------------------------------------------------------------
// Happy path — mid-month with last-month comparable window
// ---------------------------------------------------------------------------

describe("mesActualHandler — MTD + last-month comparison + projection", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FAKE_NOW_UTC);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("returns MTD spend, last-month compare window, delta, and projection", async () => {
    // April MTD: 2.100.000 COP (three txs on day 5, 10, 21).
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_DAY_5_MIDDAY,
      amountCents: -500_000_00,
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_DAY_10_MIDDAY,
      amountCents: -600_000_00,
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_TODAY_MIDDAY,
      amountCents: -1_000_000_00,
    });

    // March 1..21 window: 1.800.000 COP (two txs on day 10 and 15). The
    // March 22 tx is AFTER the cap day (21) and must NOT count.
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_MAR_10_MIDDAY,
      amountCents: -800_000_00,
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_MAR_15_MIDDAY,
      amountCents: -1_000_000_00,
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_MAR_22_MIDDAY,
      amountCents: -500_000_00,
    });

    const res = await mesActualHandler(makeCtx({ userId: USER_A }));
    expect(res.status).toBeUndefined();
    const body = res.body as SuccessBody;
    expect(body.widget_id).toBe("mes-actual");
    expect(body.size).toBe("M");
    expect(body.data.month_label).toBe("Abril 2026");
    expect(body.data.spent_cop).toBe(2_100_000);
    expect(body.data.day_of_month).toBe(21);
    expect(body.data.last_month_same_day_cop).toBe(1_800_000);
    // (2.1 / 1.8 - 1) * 100 = 16.666… → 17
    expect(body.data.delta_pct).toBe(17);
    expect(body.data.delta_direction).toBe("up");
    // spent / day * dim = 2.100.000 / 21 * 30 = 3.000.000
    expect(body.data.projection_month_end_cop).toBe(3_000_000);
    expect(body.generated_at).toMatch(/-05:00$/);
  });

  it("reports delta_direction='down' when this month is lower than last", async () => {
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_DAY_5_MIDDAY,
      amountCents: -500_000_00,
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_MAR_5_MIDDAY,
      amountCents: -1_000_000_00,
    });
    const res = await mesActualHandler(makeCtx({ userId: USER_A }));
    const body = res.body as SuccessBody;
    expect(body.data.spent_cop).toBe(500_000);
    expect(body.data.last_month_same_day_cop).toBe(1_000_000);
    expect(body.data.delta_pct).toBe(-50);
    expect(body.data.delta_direction).toBe("down");
  });

  it("reports delta_direction='flat' when this month matches last-month to the peso", async () => {
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_DAY_10_MIDDAY,
      amountCents: -777_000_00,
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_MAR_15_MIDDAY,
      amountCents: -777_000_00,
    });
    const res = await mesActualHandler(makeCtx({ userId: USER_A }));
    const body = res.body as SuccessBody;
    expect(body.data.spent_cop).toBe(777_000);
    expect(body.data.last_month_same_day_cop).toBe(777_000);
    expect(body.data.delta_pct).toBe(0);
    expect(body.data.delta_direction).toBe("flat");
  });

  it("returns null delta_pct/delta_direction when last_month_same_day_cop is 0", async () => {
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_TODAY_MIDDAY,
      amountCents: -100_000_00,
    });
    const res = await mesActualHandler(makeCtx({ userId: USER_A }));
    const body = res.body as SuccessBody;
    expect(body.data.spent_cop).toBe(100_000);
    expect(body.data.last_month_same_day_cop).toBe(0);
    expect(body.data.delta_pct).toBeNull();
    expect(body.data.delta_direction).toBeNull();
  });

  it("handles first day of month with no spend → projection 0, delta null", async () => {
    vi.setSystemTime(new Date("2026-04-01T17:00:00Z"));
    const res = await mesActualHandler(makeCtx({ userId: USER_A }));
    const body = res.body as SuccessBody;
    expect(body.data.day_of_month).toBe(1);
    expect(body.data.spent_cop).toBe(0);
    expect(body.data.projection_month_end_cop).toBe(0);
    expect(body.data.delta_pct).toBeNull();
    expect(body.data.delta_direction).toBeNull();
    vi.setSystemTime(FAKE_NOW_UTC);
  });

  it("handles first day of month with spend → delta vs last month's day 1", async () => {
    vi.setSystemTime(new Date("2026-04-01T17:00:00Z"));
    // April 1: 100.000 COP.
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: new Date("2026-04-01T18:00:00Z"),
      amountCents: -100_000_00,
    });
    // March 1: 80.000 COP.
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: new Date("2026-03-01T18:00:00Z"),
      amountCents: -80_000_00,
    });
    const res = await mesActualHandler(makeCtx({ userId: USER_A }));
    const body = res.body as SuccessBody;
    expect(body.data.day_of_month).toBe(1);
    expect(body.data.spent_cop).toBe(100_000);
    expect(body.data.last_month_same_day_cop).toBe(80_000);
    expect(body.data.delta_pct).toBe(25);
    expect(body.data.delta_direction).toBe("up");
    // 100k / 1 * 30 = 3.000.000
    expect(body.data.projection_month_end_cop).toBe(3_000_000);
    vi.setSystemTime(FAKE_NOW_UTC);
  });

  it("handles last day of month → projection ≈ spent_cop, direction honored", async () => {
    // April 30 (day 30, dim 30). Projection = spent / 30 * 30 = spent.
    vi.setSystemTime(new Date("2026-04-30T17:00:00Z"));
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: new Date("2026-04-15T18:00:00Z"),
      amountCents: -500_000_00,
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: new Date("2026-04-30T18:00:00Z"),
      amountCents: -1_500_000_00,
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: new Date("2026-03-01T18:00:00Z"),
      amountCents: -1_000_000_00,
    });
    const res = await mesActualHandler(makeCtx({ userId: USER_A }));
    const body = res.body as SuccessBody;
    expect(body.data.day_of_month).toBe(30);
    expect(body.data.spent_cop).toBe(2_000_000);
    expect(body.data.last_month_same_day_cop).toBe(1_000_000);
    expect(body.data.delta_pct).toBe(100);
    expect(body.data.delta_direction).toBe("up");
    expect(body.data.projection_month_end_cop).toBe(2_000_000);
    vi.setSystemTime(FAKE_NOW_UTC);
  });

  it("caps last-month window when current month is longer than previous (Mar after Feb)", async () => {
    // Today = 2026-03-31 (Mar has 31 days, Feb has 28). Comparison window
    // must be Feb 1..Feb 28 only — not Feb 1..Feb 31 (illegal) or through
    // some other date. A tx dated 2026-02-28 counts, a (nonexistent) tx
    // after it does not.
    vi.setSystemTime(new Date("2026-03-31T17:00:00Z"));
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: new Date("2026-03-15T18:00:00Z"),
      amountCents: -310_000_00,
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: new Date("2026-02-28T18:00:00Z"),
      amountCents: -400_000_00,
    });
    // A Feb 1 tx also counts (window start).
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: new Date("2026-02-01T18:00:00Z"),
      amountCents: -100_000_00,
    });
    const res = await mesActualHandler(makeCtx({ userId: USER_A }));
    const body = res.body as SuccessBody;
    expect(body.data.month_label).toBe("Marzo 2026");
    expect(body.data.day_of_month).toBe(31);
    expect(body.data.spent_cop).toBe(310_000);
    expect(body.data.last_month_same_day_cop).toBe(500_000);
    vi.setSystemTime(FAKE_NOW_UTC);
  });

  it("caps last-month window at last day of Feb when today ≥ 28 in March", async () => {
    // Feb 2026 has 28 days (not a leap year). Today = 2026-03-28 → cap at Feb 28.
    vi.setSystemTime(new Date("2026-03-28T17:00:00Z"));
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: new Date("2026-03-10T18:00:00Z"),
      amountCents: -200_000_00,
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: new Date("2026-02-28T18:00:00Z"),
      amountCents: -300_000_00,
    });
    const res = await mesActualHandler(makeCtx({ userId: USER_A }));
    const body = res.body as SuccessBody;
    expect(body.data.day_of_month).toBe(28);
    expect(body.data.spent_cop).toBe(200_000);
    expect(body.data.last_month_same_day_cop).toBe(300_000);
    vi.setSystemTime(FAKE_NOW_UTC);
  });

  it("handles Apr 30 after Mar 31 — uses all of Mar 1..30 (cap = today.day)", async () => {
    // Today = 2026-04-30 → dayOfMonth=30, prevDim(March)=31, cap=min(30,31)=30.
    // A Mar 30 tx counts, a Mar 31 tx does NOT (outside the cap).
    vi.setSystemTime(new Date("2026-04-30T17:00:00Z"));
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: new Date("2026-03-30T18:00:00Z"),
      amountCents: -700_000_00,
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: new Date("2026-03-31T18:00:00Z"),
      amountCents: -999_000_00,
    });
    const res = await mesActualHandler(makeCtx({ userId: USER_A }));
    const body = res.body as SuccessBody;
    expect(body.data.day_of_month).toBe(30);
    expect(body.data.last_month_same_day_cop).toBe(700_000);
    vi.setSystemTime(FAKE_NOW_UTC);
  });

  it("handles December → November of the same year", async () => {
    // Today = 2026-12-15. Last month = November 2026 (30 days).
    vi.setSystemTime(new Date("2026-12-15T17:00:00Z"));
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: new Date("2026-12-10T18:00:00Z"),
      amountCents: -150_000_00,
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: new Date("2026-11-10T18:00:00Z"),
      amountCents: -100_000_00,
    });
    // A tx in October must NOT count (outside window).
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: new Date("2026-10-10T18:00:00Z"),
      amountCents: -900_000_00,
    });
    const res = await mesActualHandler(makeCtx({ userId: USER_A }));
    const body = res.body as SuccessBody;
    expect(body.data.month_label).toBe("Diciembre 2026");
    expect(body.data.day_of_month).toBe(15);
    expect(body.data.spent_cop).toBe(150_000);
    expect(body.data.last_month_same_day_cop).toBe(100_000);
    expect(body.data.delta_pct).toBe(50);
    expect(body.data.delta_direction).toBe("up");
    vi.setSystemTime(FAKE_NOW_UTC);
  });

  it("handles January → December of the previous year (year wrap)", async () => {
    // Today = 2027-01-10. Last month = December 2026 (31 days).
    vi.setSystemTime(new Date("2027-01-10T17:00:00Z"));
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: new Date("2027-01-05T18:00:00Z"),
      amountCents: -50_000_00,
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: new Date("2026-12-05T18:00:00Z"),
      amountCents: -80_000_00,
    });
    // A tx from November 2026 must NOT count.
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: new Date("2026-11-05T18:00:00Z"),
      amountCents: -999_000_00,
    });
    const res = await mesActualHandler(makeCtx({ userId: USER_A }));
    const body = res.body as SuccessBody;
    expect(body.data.month_label).toBe("Enero 2027");
    expect(body.data.day_of_month).toBe(10);
    expect(body.data.spent_cop).toBe(50_000);
    expect(body.data.last_month_same_day_cop).toBe(80_000);
    // Math.round(-37.5) === -37 in JS (rounds half toward +∞), so delta_pct=-37.
    expect(body.data.delta_pct).toBe(-37);
    expect(body.data.delta_direction).toBe("down");
    vi.setSystemTime(FAKE_NOW_UTC);
  });

  it("excludes transfers, balance adjustments, soft-deleted, and credits", async () => {
    // One real outflow (10k counts).
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_TODAY_MIDDAY,
      amountCents: -10_000_00,
    });
    // Transfer — excluded.
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_DAY_5_MIDDAY,
      amountCents: -500_000_00,
      channel: "transfer",
    });
    // Balance adjustment — excluded.
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_DAY_10_MIDDAY,
      amountCents: -100_000_00,
      source: "balance_adjustment",
      channel: "manual",
      isAdjustment: true,
    });
    // Soft-deleted — excluded.
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_DAY_10_MIDDAY,
      amountCents: -80_000_00,
      deletedAt: BOGOTA_DAY_10_MIDDAY,
    });
    // Credit / refund (positive amount) — excluded.
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_TODAY_MIDDAY,
      amountCents: 50_000_00,
    });
    // Last month — transfer (excluded) + real outflow (counts).
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_MAR_10_MIDDAY,
      amountCents: -200_000_00,
      channel: "transfer",
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_COP,
      occurredAt: BOGOTA_MAR_10_MIDDAY,
      amountCents: -20_000_00,
    });
    const res = await mesActualHandler(makeCtx({ userId: USER_A }));
    const body = res.body as SuccessBody;
    expect(body.data.spent_cop).toBe(10_000);
    expect(body.data.last_month_same_day_cop).toBe(20_000);
  });

  it("is isolated per user (cross-tenant)", async () => {
    // User B burns it up — must not leak into A's widget.
    await insertTx({
      userId: USER_B,
      accountId: ACCT_B_COP,
      occurredAt: BOGOTA_TODAY_MIDDAY,
      amountCents: -9_999_999_00,
    });
    await insertTx({
      userId: USER_B,
      accountId: ACCT_B_COP,
      occurredAt: BOGOTA_MAR_21_MIDDAY,
      amountCents: -8_888_888_00,
    });
    const res = await mesActualHandler(makeCtx({ userId: USER_A }));
    const body = res.body as SuccessBody;
    expect(body.data.spent_cop).toBe(0);
    expect(body.data.last_month_same_day_cop).toBe(0);
  });

  it("converts USD txs at the current FX rate", async () => {
    // $25 USD @ TRM 4000 → 100.000 COP (current). $10 USD → 40.000 COP (last month).
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_USD,
      occurredAt: BOGOTA_TODAY_MIDDAY,
      amountCents: -25_00,
      currency: "USD",
    });
    await insertTx({
      userId: USER_A,
      accountId: ACCT_A_USD,
      occurredAt: BOGOTA_MAR_21_MIDDAY,
      amountCents: -10_00,
      currency: "USD",
    });
    const res = await mesActualHandler(makeCtx({ userId: USER_A }));
    const body = res.body as SuccessBody;
    expect(body.data.spent_cop).toBe(100_000);
    expect(body.data.last_month_same_day_cop).toBe(40_000);
    expect(body.data.delta_pct).toBe(150); // (100/40 - 1) * 100 = 150
    expect(body.data.delta_direction).toBe("up");
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("mesActualHandler — errors", () => {
  it("returns 422 invalid_params when size is S", async () => {
    const res = await mesActualHandler(makeCtx({ userId: USER_A, size: "S" }));
    expect(res.status).toBe(422);
    expect((res.body as ErrorBody).error.code).toBe("invalid_params");
  });

  it("returns 422 invalid_params when size is L", async () => {
    const res = await mesActualHandler(makeCtx({ userId: USER_A, size: "L" }));
    expect(res.status).toBe(422);
    expect((res.body as ErrorBody).error.code).toBe("invalid_params");
  });
});

// ---------------------------------------------------------------------------
// Pure helpers — cheap sanity checks so daysInMonth / month label regressions
// show up next to the handler that consumes them.
// ---------------------------------------------------------------------------

describe("daysInMonth", () => {
  it("returns 31 for January, 30 for April, 28 for Feb 2026 (non-leap)", () => {
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 2)).toBe(28);
  });

  it("returns 29 for Feb in a leap year", () => {
    expect(daysInMonth(2024, 2)).toBe(29);
  });

  it("returns 31 for December (year end)", () => {
    expect(daysInMonth(2026, 12)).toBe(31);
  });
});

describe("formatMonthLabel", () => {
  it("formats as 'Mes AAAA' with capitalized long month in Bogota", () => {
    // 2026-04-21 midday UTC is still 2026-04-21 in Bogota.
    expect(formatMonthLabel(new Date("2026-04-21T18:00:00Z"))).toBe("Abril 2026");
  });

  it("rolls to the previous Bogota date at the UTC month edge", () => {
    // 03:00 UTC on Jan 1 == 22:00 Bogota on Dec 31.
    expect(formatMonthLabel(new Date("2027-01-01T03:00:00Z"))).toBe("Diciembre 2026");
  });
});
