import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { migratePagoTcToTransfer } from "./migrate-pago-tc-to-transfer";

// #405: integration tests for the historical backfill script. Verifies that
// it converts legacy `pago-tc` rows into transfer groups and that it is
// idempotent (re-runs do not double-migrate or touch already-migrated rows).

const TEST_USER_ID = 1;
const EXT_PREFIX = "test-migrate-pagotc:";

async function cleanup() {
  await db.execute(sql`
    DELETE FROM transactions
    WHERE external_id LIKE ${EXT_PREFIX + "%"}
       OR raw_data ->> 'source' = 'migrate-pago-tc-to-transfer'
  `);
}

beforeEach(cleanup);
afterEach(cleanup);

async function savingsId(): Promise<number> {
  const [row] = await db.execute<{ id: number }>(sql`
    SELECT id FROM accounts WHERE user_id = ${TEST_USER_ID} AND name = 'Bancolombia Ahorros' LIMIT 1
  `);
  return row.id;
}
async function visaId(): Promise<number> {
  const [row] = await db.execute<{ id: number }>(sql`
    SELECT id FROM accounts WHERE user_id = ${TEST_USER_ID} AND name = 'Bancolombia Visa *2575' LIMIT 1
  `);
  return row.id;
}

async function seedLegacyPagoTc(opts: {
  externalId: string;
  accountId: number;
  amountCents: bigint;
  description: string;
}): Promise<number> {
  const [row] = await db.execute<{ id: number }>(sql`
    INSERT INTO transactions (
      user_id, account_id, occurred_at, amount_cents, currency,
      description_raw, category_slug, classification_method, source, external_id
    ) VALUES (
      ${TEST_USER_ID}, ${opts.accountId}, now(), ${opts.amountCents.toString()}::bigint,
      'COP', ${opts.description}, 'pago-tc', 'manual'::classification_method,
      'sms'::tx_source, ${opts.externalId}
    )
    RETURNING id
  `);
  return row.id;
}

describe("migratePagoTcToTransfer (#405)", () => {
  it("converts a legacy payment (amount < 0 + parseable description) into a paired group", async () => {
    const savings = await savingsId();
    const visa = await visaId();
    const legacyId = await seedLegacyPagoTc({
      externalId: `${EXT_PREFIX}paired`,
      accountId: savings,
      amountCents: BigInt(-250000),
      description: "Pago TC *2575",
    });

    const report = await migratePagoTcToTransfer();
    expect(report.migratedPaired).toBeGreaterThanOrEqual(1);

    const [origin] = await db.execute<{
      category_slug: string | null;
      channel: string;
      transfer_group_id: string | null;
    }>(sql`
      SELECT category_slug, channel, transfer_group_id
      FROM transactions WHERE id = ${legacyId}
    `);
    expect(origin.category_slug).toBeNull();
    expect(origin.channel).toBe("transfer");
    expect(origin.transfer_group_id).not.toBeNull();

    const companions = await db.execute<{
      account_id: number;
      amount_cents: string;
    }>(sql`
      SELECT account_id, amount_cents::text
      FROM transactions
      WHERE transfer_group_id = ${origin.transfer_group_id}::uuid
        AND id <> ${legacyId}
    `);
    expect(companions.length).toBe(1);
    expect(companions[0].account_id).toBe(visa);
    expect(BigInt(companions[0].amount_cents)).toBe(BigInt(250000));
  });

  it("strips the category and sets channel=transfer for unpaired abonos (amount > 0)", async () => {
    const visa = await visaId();
    const abonoId = await seedLegacyPagoTc({
      externalId: `${EXT_PREFIX}abono`,
      accountId: visa,
      amountCents: BigInt(150000),
      description: "Abono de FULANO a TC *2575",
    });

    const report = await migratePagoTcToTransfer();
    expect(report.migratedUnpaired).toBeGreaterThanOrEqual(1);

    const [row] = await db.execute<{
      category_slug: string | null;
      channel: string;
      transfer_group_id: string | null;
    }>(
      sql`SELECT category_slug, channel, transfer_group_id FROM transactions WHERE id = ${abonoId}`,
    );
    expect(row.category_slug).toBeNull();
    expect(row.channel).toBe("transfer");
    expect(row.transfer_group_id).toBeNull();
  });

  it("leaves rows untouched when the TC destination cannot be inferred from the description", async () => {
    const savings = await savingsId();
    const weirdId = await seedLegacyPagoTc({
      externalId: `${EXT_PREFIX}weird`,
      accountId: savings,
      amountCents: BigInt(-10000),
      description: "Pago manual TC genérica",
    });

    const report = await migratePagoTcToTransfer();
    expect(report.skippedNoDestination).toBeGreaterThanOrEqual(1);

    const [row] = await db.execute<{
      category_slug: string | null;
      transfer_group_id: string | null;
    }>(sql`SELECT category_slug, transfer_group_id FROM transactions WHERE id = ${weirdId}`);
    expect(row.category_slug).toBe("pago-tc");
    expect(row.transfer_group_id).toBeNull();
  });

  it("is idempotent — second run processes zero rows for already-migrated payments", async () => {
    const savings = await savingsId();
    await seedLegacyPagoTc({
      externalId: `${EXT_PREFIX}idem`,
      accountId: savings,
      amountCents: BigInt(-30000),
      description: "Pago TC *2575",
    });

    const first = await migratePagoTcToTransfer();
    expect(first.migratedPaired).toBeGreaterThanOrEqual(1);

    const second = await migratePagoTcToTransfer();
    // Rows migrated in the first pass have transfer_group_id set, so the
    // WHERE clause skips them — the second pass sees nothing new from ours.
    expect(second.processed).toBeLessThan(first.processed);
  });
});
