import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  applyInteresesCausadosForCycle,
  computeInterestForCycle,
  cycleAnchor,
} from "./intereses-causados-job";

// #407: integration tests for the intereses-causados job. Uses the real test
// DB (findash_test) — seeds a TC account + purchases, runs the job, inspects
// the synthetic tx. Exercises: happy path, idempotency, zero-interest skip,
// rate fallback to the account bucket, and tenancy.

const TEST_USER_ID = 1;
const EXT_PREFIX = "test-intereses:";

async function cleanup() {
  await db.execute(sql`
    DELETE FROM transactions
    WHERE external_id LIKE ${EXT_PREFIX + "%"}
       OR raw_data ->> 'job' = 'intereses-causados-job'
  `);
}

beforeEach(cleanup);
afterEach(cleanup);

async function getVisaId(): Promise<number> {
  const [row] = await db.execute<{ id: number }>(sql`
    SELECT id FROM accounts WHERE user_id = ${TEST_USER_ID} AND name = 'Bancolombia Visa *2575' LIMIT 1
  `);
  return row.id;
}

async function setBucketRates(
  accountId: number,
  buckets: { oneMonth: number; months2to36: number; advances: number },
) {
  await db.execute(sql`
    UPDATE accounts
    SET metadata = jsonb_set(metadata, '{creditRateBuckets}', ${JSON.stringify(buckets)}::jsonb),
        updated_at = now()
    WHERE id = ${accountId}
  `);
}

async function setCutoffDay(accountId: number, day: number | null) {
  if (day === null) {
    await db.execute(sql`
      UPDATE accounts
      SET metadata = metadata - 'cutoffDay', updated_at = now()
      WHERE id = ${accountId}
    `);
  } else {
    await db.execute(sql`
      UPDATE accounts
      SET metadata = jsonb_set(metadata, '{cutoffDay}', ${day.toString()}::jsonb),
          updated_at = now()
      WHERE id = ${accountId}
    `);
  }
}

async function getMastercardUsdId(): Promise<number> {
  const [row] = await db.execute<{ id: number }>(sql`
    SELECT id FROM accounts
    WHERE user_id = ${TEST_USER_ID}
      AND name = 'Bancolombia Mastercard *7291'
      AND currency = 'USD'
    LIMIT 1
  `);
  return row.id;
}

async function seedPurchase(opts: {
  accountId: number;
  externalId: string;
  amountCentsMagnitude: bigint;
  occurredAt: string; // YYYY-MM-DD
  installmentsTotal: number;
  installmentRateEmX10k: number | null;
  currency?: string; // defaults to 'COP'
}) {
  const rateSql =
    opts.installmentRateEmX10k === null ? sql`NULL` : sql`${opts.installmentRateEmX10k}`;
  const currency = opts.currency ?? "COP";
  const [row] = await db.execute<{ id: number }>(sql`
    INSERT INTO transactions (
      user_id, account_id, occurred_at, amount_cents, currency, description_raw,
      classification_method, source, external_id, installments_total, installment_rate_bps
    ) VALUES (
      ${TEST_USER_ID}, ${opts.accountId}, ${`${opts.occurredAt}T12:00:00Z`}::timestamptz,
      ${(-opts.amountCentsMagnitude).toString()}::bigint, ${currency},
      ${`test purchase ${opts.externalId}`},
      'unclassified'::classification_method, 'sms',
      ${opts.externalId}, ${opts.installmentsTotal}, ${rateSql}
    )
    RETURNING id
  `);
  return row.id;
}

describe("cycleAnchor (#413)", () => {
  it("anchors at end-of-day UTC on the requested cut day", () => {
    const d = cycleAnchor("2026-03", 30);
    expect(d.toISOString()).toBe("2026-03-30T23:00:00.000Z");
  });

  it("clamps cutDay=31 to Feb 28 in a non-leap year", () => {
    expect(cycleAnchor("2026-02", 31).getUTCDate()).toBe(28);
  });

  it("clamps cutDay=31 to Feb 29 in a leap year", () => {
    expect(cycleAnchor("2024-02", 31).getUTCDate()).toBe(29);
  });

  it("clamps cutDay=31 to April 30", () => {
    expect(cycleAnchor("2026-04", 31).getUTCDate()).toBe(30);
  });

  it("keeps the nominal day when it exists in the month", () => {
    expect(cycleAnchor("2026-03", 15).getUTCDate()).toBe(15);
  });

  it("rejects invalid cut days", () => {
    expect(() => cycleAnchor("2026-03", 0)).toThrow(/invalid cutDay/);
    expect(() => cycleAnchor("2026-03", 32)).toThrow(/invalid cutDay/);
    expect(() => cycleAnchor("2026-03", 1.5)).toThrow(/invalid cutDay/);
  });

  it("rejects malformed cycles", () => {
    expect(() => cycleAnchor("bad", 15)).toThrow(/invalid cycle/);
    expect(() => cycleAnchor("2026", 15)).toThrow(/invalid cycle/);
  });
});

describe("computeInterestForCycle", () => {
  it("returns the interest due on the next unpaid cuota", async () => {
    const visa = await getVisaId();
    await setBucketRates(visa, { oneMonth: 0, months2to36: 19110, advances: 19110 });

    // 100_000 pesos @ 19110 x10k (1.9110% EM) × 12 cuotas. Capital per cuota
    // = 8333 pesos (since 100_000 / 12 = 8333.33 → floor to peso). Interest
    // on month 1 (grace=true so month-1 cuota only covers capital; the
    // scheduled interest the job reports is month-2's, which folds the
    // deferred month-1 interest in).
    await seedPurchase({
      accountId: visa,
      externalId: `${EXT_PREFIX}base`,
      amountCentsMagnitude: BigInt(10_000_000),
      occurredAt: "2026-03-10",
      installmentsTotal: 12,
      installmentRateEmX10k: 19110,
    });

    const run = await computeInterestForCycle({
      userId: TEST_USER_ID,
      accountId: visa,
      cycle: "2026-04",
    });
    expect(run.intereses.length).toBe(1);
    expect(run.intereses[0].rateEmX10k).toBe(19110);
    expect(run.totalInterestCents).toBeGreaterThan(BigInt(0));
  });

  it("falls back to the account's rate bucket when the tx has no explicit rate", async () => {
    const visa = await getVisaId();
    await setBucketRates(visa, { oneMonth: 0, months2to36: 20000, advances: 20000 });

    await seedPurchase({
      accountId: visa,
      externalId: `${EXT_PREFIX}fallback`,
      amountCentsMagnitude: BigInt(5_000_000),
      occurredAt: "2026-03-10",
      installmentsTotal: 6,
      installmentRateEmX10k: null, // inherit from bucket
    });

    const run = await computeInterestForCycle({
      userId: TEST_USER_ID,
      accountId: visa,
      cycle: "2026-04",
    });
    expect(run.intereses.length).toBe(1);
    expect(run.intereses[0].rateEmX10k).toBe(20000);
  });

  it("picks up the account's cutoffDay — a later cut → one more cuota paid → less interest (#413)", async () => {
    const visa = await getVisaId();
    await setBucketRates(visa, { oneMonth: 0, months2to36: 19110, advances: 19110 });

    // Purchase on Jan 20 with an explicit per-tx rate. Cycle "2026-03".
    // With cutDay=15 the anchor is Mar 15 and monthsBetween(Jan 20, Mar 15)
    // decrements by one (15 < 20) → paidCount=1 → charges cuota 2 on a high
    // balance. With cutDay=30 the anchor is Mar 30 and the decrement doesn't
    // happen (30 >= 20) → paidCount=2 → charges cuota 3 on a lower balance.
    // This is the exact scenario that #413 fixes.
    await seedPurchase({
      accountId: visa,
      externalId: `${EXT_PREFIX}cutoff-drives-paidcount`,
      amountCentsMagnitude: BigInt(247_990_000), // 2_479_900 pesos
      occurredAt: "2026-01-20",
      installmentsTotal: 12,
      installmentRateEmX10k: 18311,
    });

    await setCutoffDay(visa, 15);
    const early = await computeInterestForCycle({
      userId: TEST_USER_ID,
      accountId: visa,
      cycle: "2026-03",
    });
    expect(early.intereses[0].installmentsPaid).toBe(1);

    await setCutoffDay(visa, 30);
    const late = await computeInterestForCycle({
      userId: TEST_USER_ID,
      accountId: visa,
      cycle: "2026-03",
    });
    expect(late.intereses[0].installmentsPaid).toBe(2);

    // A later cut means more cuotas have been paid → smaller outstanding
    // balance → smaller interest this cycle.
    expect(late.totalInterestCents).toBeLessThan(early.totalInterestCents);
    expect(late.anchor.getUTCDate()).toBe(30);
    expect(early.anchor.getUTCDate()).toBe(15);
  });

  it("falls back to last-day-of-month when cutoffDay is missing (#413)", async () => {
    const visa = await getVisaId();
    await setBucketRates(visa, { oneMonth: 0, months2to36: 19110, advances: 19110 });
    await setCutoffDay(visa, null);

    await seedPurchase({
      accountId: visa,
      externalId: `${EXT_PREFIX}cutoff-missing`,
      amountCentsMagnitude: BigInt(1_000_000),
      occurredAt: "2026-03-10",
      installmentsTotal: 6,
      installmentRateEmX10k: 19110,
    });

    const run = await computeInterestForCycle({
      userId: TEST_USER_ID,
      accountId: visa,
      cycle: "2026-04",
    });
    // April has 30 days, so cutDay=31 clamps to 30.
    expect(run.anchor.getUTCMonth()).toBe(3); // April (0-indexed)
    expect(run.anchor.getUTCDate()).toBe(30);
  });

  it("flags multi-cuota without explicit rate AND without matching bucket as needsRate (#416)", async () => {
    const visa = await getVisaId();
    // Clear any buckets so months2to36 lookup returns null → needsRate path.
    await db.execute(sql`
      UPDATE accounts SET metadata = metadata - 'creditRateBuckets', updated_at = now()
      WHERE id = ${visa}
    `);

    await seedPurchase({
      accountId: visa,
      externalId: `${EXT_PREFIX}needs-rate`,
      amountCentsMagnitude: BigInt(1_000_000),
      occurredAt: "2026-03-10",
      installmentsTotal: 6,
      installmentRateEmX10k: null, // no explicit rate
    });

    const run = await computeInterestForCycle({
      userId: TEST_USER_ID,
      accountId: visa,
      cycle: "2026-04",
    });

    expect(run.intereses.length).toBe(1);
    expect(run.intereses[0].needsRate).toBe(true);
    expect(run.intereses[0].interestCents).toBe(BigInt(0));
    expect(run.purchasesNeedingRate).toBe(1);
    // No priced purchases → total stays at zero (NOT silently booked).
    expect(run.totalInterestCents).toBe(BigInt(0));
  });

  it("does NOT flag 1-cuota purchases as needsRate even without bucket (#416)", async () => {
    const visa = await getVisaId();
    await db.execute(sql`
      UPDATE accounts SET metadata = metadata - 'creditRateBuckets', updated_at = now()
      WHERE id = ${visa}
    `);

    await seedPurchase({
      accountId: visa,
      externalId: `${EXT_PREFIX}one-cuota-no-bucket`,
      amountCentsMagnitude: BigInt(500_000),
      occurredAt: "2026-03-10",
      installmentsTotal: 1,
      installmentRateEmX10k: null,
    });

    const run = await computeInterestForCycle({
      userId: TEST_USER_ID,
      accountId: visa,
      cycle: "2026-04",
    });

    // 1-cuota diferido sin intereses — no flag, no row surfaced.
    expect(run.intereses.length).toBe(0);
    expect(run.purchasesNeedingRate).toBe(0);
    expect(run.totalInterestCents).toBe(BigInt(0));
  });

  it("mixes priced and needsRate purchases correctly: total only counts priced (#416)", async () => {
    const visa = await getVisaId();
    // No bucket → unpriced multi-cuota falls to needsRate.
    await db.execute(sql`
      UPDATE accounts SET metadata = metadata - 'creditRateBuckets', updated_at = now()
      WHERE id = ${visa}
    `);

    // Priced (has explicit rate).
    await seedPurchase({
      accountId: visa,
      externalId: `${EXT_PREFIX}mix-priced`,
      amountCentsMagnitude: BigInt(10_000_000),
      occurredAt: "2026-03-10",
      installmentsTotal: 12,
      installmentRateEmX10k: 19110,
    });
    // Unpriced — multi-cuota without bucket or rate.
    await seedPurchase({
      accountId: visa,
      externalId: `${EXT_PREFIX}mix-needsrate`,
      amountCentsMagnitude: BigInt(5_000_000),
      occurredAt: "2026-03-10",
      installmentsTotal: 6,
      installmentRateEmX10k: null,
    });

    const run = await computeInterestForCycle({
      userId: TEST_USER_ID,
      accountId: visa,
      cycle: "2026-04",
    });

    expect(run.intereses.length).toBe(2);
    expect(run.purchasesNeedingRate).toBe(1);
    const priced = run.intereses.find((i) => !i.needsRate);
    const unpriced = run.intereses.find((i) => i.needsRate);
    expect(priced?.rateEmX10k).toBe(19110);
    expect(unpriced?.rateEmX10k).toBe(0);
    // The total reflects ONLY the priced row — the unpriced 0n must not mask
    // the fact that we don't know its interest.
    expect(run.totalInterestCents).toBe(priced!.interestCents);
    expect(run.totalInterestCents).toBeGreaterThan(BigInt(0));
  });

  it("skips purchases with 1 cuota + 0% oneMonth bucket (diferido nominal)", async () => {
    const visa = await getVisaId();
    await setBucketRates(visa, { oneMonth: 0, months2to36: 19110, advances: 19110 });

    await seedPurchase({
      accountId: visa,
      externalId: `${EXT_PREFIX}zero`,
      amountCentsMagnitude: BigInt(500_000),
      occurredAt: "2026-03-10",
      installmentsTotal: 1,
      installmentRateEmX10k: null,
    });

    const run = await computeInterestForCycle({
      userId: TEST_USER_ID,
      accountId: visa,
      cycle: "2026-04",
    });
    expect(run.intereses.length).toBe(0);
    expect(run.totalInterestCents).toBe(BigInt(0));
  });
});

describe("applyInteresesCausadosForCycle", () => {
  it("inserts a synthetic tx with category intereses-tc on first run", async () => {
    const visa = await getVisaId();
    await setBucketRates(visa, { oneMonth: 0, months2to36: 19110, advances: 19110 });
    await seedPurchase({
      accountId: visa,
      externalId: `${EXT_PREFIX}ins-1`,
      amountCentsMagnitude: BigInt(20_000_000),
      occurredAt: "2026-03-10",
      installmentsTotal: 12,
      installmentRateEmX10k: 19110,
    });

    const result = await applyInteresesCausadosForCycle({
      userId: TEST_USER_ID,
      accountId: visa,
      cycle: "2026-04",
    });
    expect(result.status).toBe("inserted");
    if (result.status !== "inserted") return;

    const [row] = await db.execute<{
      category_slug: string;
      amount_cents: string;
      channel: string;
      description_raw: string;
    }>(sql`
      SELECT category_slug, amount_cents::text, channel, description_raw
      FROM transactions WHERE id = ${result.txId}
    `);
    expect(row.category_slug).toBe("intereses-tc");
    expect(row.channel).toBe("manual");
    expect(BigInt(row.amount_cents)).toBeLessThan(BigInt(0)); // expense
    expect(row.description_raw).toContain("Intereses causados");
    expect(row.description_raw).toContain("2026-04");
  });

  it("is idempotent — second call returns skipped/already-run", async () => {
    const visa = await getVisaId();
    await setBucketRates(visa, { oneMonth: 0, months2to36: 19110, advances: 19110 });
    await seedPurchase({
      accountId: visa,
      externalId: `${EXT_PREFIX}idem`,
      amountCentsMagnitude: BigInt(10_000_000),
      occurredAt: "2026-03-10",
      installmentsTotal: 12,
      installmentRateEmX10k: 19110,
    });

    const first = await applyInteresesCausadosForCycle({
      userId: TEST_USER_ID,
      accountId: visa,
      cycle: "2026-04",
    });
    expect(first.status).toBe("inserted");

    const second = await applyInteresesCausadosForCycle({
      userId: TEST_USER_ID,
      accountId: visa,
      cycle: "2026-04",
    });
    expect(second.status).toBe("skipped");
    if (second.status === "skipped") expect(second.reason).toBe("already-run");

    // Still exactly one synthetic row for this (account, cycle).
    const rows = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM transactions
      WHERE user_id = ${TEST_USER_ID}
        AND account_id = ${visa}
        AND raw_data ->> 'cycleKey' = ${`${visa}-2026-04`}
    `);
    expect(rows[0].n).toBe("1");
  });

  it("returns skipped/zero-interest when there are no live purchases", async () => {
    const visa = await getVisaId();
    // No seeded purchases; existing test DB tx shouldn't match due to cycle.
    const result = await applyInteresesCausadosForCycle({
      userId: TEST_USER_ID,
      accountId: visa,
      cycle: "2099-12", // far-future cycle, nothing will be live
    });
    expect(result.status).toBe("skipped");
  });

  it("errors when the account is not a credit_card", async () => {
    const [sav] = await db.execute<{ id: number }>(sql`
      SELECT id FROM accounts WHERE user_id = ${TEST_USER_ID} AND name = 'Bancolombia Ahorros' LIMIT 1
    `);
    await expect(
      applyInteresesCausadosForCycle({
        userId: TEST_USER_ID,
        accountId: sav.id,
        cycle: "2026-04",
      }),
    ).rejects.toThrow(/not a credit card/);
  });
});

// Regression #778 — grace-month-1 prorrateo days-active second pass removed.
// Two cases:
//   A — TC *8268 USD ABR2026: Patreon $9 USD cuota 1/36 posted 1 day before
//       anchor → extracto shows "Intereses corrientes: 0,00". Pre-fix: the
//       second pass returned 1¢ phantom interest. Post-fix: 0 entries, $0 total.
//   B — invariant on emitted rows: a mature purchase (paidCount >= 1) MUST
//       have gracePeriodPartialCents === 0n on every emitted row (the field is
//       kept for read-compat with existing prod synthetic txs but is always 0n).
describe("computeInterestForCycle — regression #778 grace-month-1 prorrateo removed", () => {
  it("Case A: returns zero interest for a cuota 1/36 USD purchase posted 1 day before anchor (TC *8268 USD scenario)", async () => {
    const mcUsd = await getMastercardUsdId();
    // TC USD card: rate 19915 (1.9915% EM), cutDay=30 → Apr 30 anchor.
    await setBucketRates(mcUsd, { oneMonth: 0, months2to36: 19915, advances: 19915 });
    await setCutoffDay(mcUsd, 30);

    // Patreon $9 USD posted 2026-04-29 — cuota 1 of 36, grace month applies.
    // Pre-fix: second pass computed gracePartial = 1¢ via días-activos prorrateo.
    // Post-fix: no second pass → total = 0, no intereses entry.
    await seedPurchase({
      accountId: mcUsd,
      externalId: `${EXT_PREFIX}778-patreon-usd`,
      amountCentsMagnitude: BigInt(900), // $9.00 USD in cents
      occurredAt: "2026-04-29",
      installmentsTotal: 36,
      installmentRateEmX10k: 19915,
      currency: "USD",
    });

    const run = await computeInterestForCycle({
      userId: TEST_USER_ID,
      accountId: mcUsd,
      cycle: "2026-04",
    });

    // Extracto *8268 USD ABR2026 shows Intereses corrientes 0,00.
    expect(run.totalInterestCents).toBe(BigInt(0));
    expect(run.intereses.length).toBe(0);
  });

  it("Case B: gracePeriodPartialCents is always 0n on emitted intereses rows (mature purchase, paidCount >= 1)", async () => {
    const visa = await getVisaId();
    await setBucketRates(visa, { oneMonth: 0, months2to36: 19110, advances: 19110 });
    await setCutoffDay(visa, 30);

    // Purchase on 2026-01-15 with explicit rate. Cycle "2026-04", cutDay=30
    // → anchor Apr 30. monthsBetween(Jan 15, Apr 30) = 3 (30 >= 15, no decrement)
    // → paidCount = 3 → mature, so this row IS emitted in intereses.
    await seedPurchase({
      accountId: visa,
      externalId: `${EXT_PREFIX}778-mature-cop`,
      amountCentsMagnitude: BigInt(1_000_000), // $10,000 COP
      occurredAt: "2026-01-15",
      installmentsTotal: 12,
      installmentRateEmX10k: 19110,
    });

    const run = await computeInterestForCycle({
      userId: TEST_USER_ID,
      accountId: visa,
      cycle: "2026-04",
    });

    // The mature purchase is priced → at least 1 row is emitted.
    expect(run.intereses.length).toBeGreaterThanOrEqual(1);
    // Invariant: gracePeriodPartialCents is always 0n after #778 (field kept
    // for read-compat with existing prod synthetic txs — the second pass that
    // populated it was deleted).
    for (const i of run.intereses) {
      expect(i.gracePeriodPartialCents).toBe(BigInt(0));
    }
  });
});
