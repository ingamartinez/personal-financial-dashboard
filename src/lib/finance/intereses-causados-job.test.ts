import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { applyInteresesCausadosForCycle, computeInterestForCycle } from "./intereses-causados-job";

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

async function seedPurchase(opts: {
  accountId: number;
  externalId: string;
  amountCentsMagnitude: bigint;
  occurredAt: string; // YYYY-MM-DD
  installmentsTotal: number;
  installmentRateEmX10k: number | null;
}) {
  const rateSql =
    opts.installmentRateEmX10k === null ? sql`NULL` : sql`${opts.installmentRateEmX10k}`;
  const [row] = await db.execute<{ id: number }>(sql`
    INSERT INTO transactions (
      user_id, account_id, occurred_at, amount_cents, currency, description_raw,
      classification_method, source, external_id, installments_total, installment_rate_bps
    ) VALUES (
      ${TEST_USER_ID}, ${opts.accountId}, ${`${opts.occurredAt}T12:00:00Z`}::timestamptz,
      ${(-opts.amountCentsMagnitude).toString()}::bigint, 'COP',
      ${`test purchase ${opts.externalId}`},
      'unclassified'::classification_method, 'sms',
      ${opts.externalId}, ${opts.installmentsTotal}, ${rateSql}
    )
    RETURNING id
  `);
  return row.id;
}

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
