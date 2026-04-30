import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { detectAndEnqueueRuleProposals } from "./proposals";

const TEST_USER_ID = 1;
const MERCHANT_PREFIX = "TEST-PROP-";

async function cleanup() {
  await db.execute(sql`
    DELETE FROM rule_proposals
    WHERE user_id = ${TEST_USER_ID} AND merchant LIKE ${MERCHANT_PREFIX + "%"}
  `);
  await db.execute(sql`
    DELETE FROM classification_corrections
    WHERE user_id = ${TEST_USER_ID} AND merchant LIKE ${MERCHANT_PREFIX + "%"}
  `);
  await db.execute(sql`
    DELETE FROM transactions
    WHERE user_id = ${TEST_USER_ID} AND external_id LIKE ${MERCHANT_PREFIX + "%"}
  `);
}

async function seedCorrection(args: {
  merchant: string;
  newCategory: string;
  daysAgo?: number;
  externalId: string;
}): Promise<void> {
  const [acc] = await db.execute<{ id: number }>(sql`
    SELECT id FROM accounts WHERE name = 'Bancolombia Ahorros' LIMIT 1
  `);
  const [tx] = await db.execute<{ id: number }>(sql`
    INSERT INTO transactions (
      user_id, account_id, occurred_at, amount_cents, currency, description_raw,
      merchant, classification_method, source, external_id
    ) VALUES (
      ${TEST_USER_ID}, ${acc.id}, now(), -5000, 'COP', 'test',
      ${args.merchant}, 'manual'::classification_method, 'sms', ${args.externalId}
    )
    RETURNING id
  `);
  await db.execute(sql`
    INSERT INTO classification_corrections (
      user_id, transaction_id, merchant, new_category_slug, created_at
    ) VALUES (
      ${TEST_USER_ID}, ${tx.id}, ${args.merchant}, ${args.newCategory},
      now() - (interval '1 day' * ${args.daysAgo ?? 0})
    )
  `);
}

beforeEach(cleanup);
afterEach(cleanup);

describe("detectAndEnqueueRuleProposals", () => {
  it("does nothing when no merchant reaches 3+ corrections", async () => {
    await seedCorrection({
      merchant: `${MERCHANT_PREFIX}LOW1`,
      newCategory: "alimentacion",
      externalId: `${MERCHANT_PREFIX}low-a`,
    });
    await seedCorrection({
      merchant: `${MERCHANT_PREFIX}LOW1`,
      newCategory: "alimentacion",
      externalId: `${MERCHANT_PREFIX}low-b`,
    });

    const result = await detectAndEnqueueRuleProposals();

    expect(result.scanned).toBe(0);
    expect(result.inserted).toBe(0);
    expect(result.proposals).toEqual([]);

    const proposals = await db.execute(sql`
      SELECT 1 FROM rule_proposals WHERE user_id = ${TEST_USER_ID}
        AND merchant = ${`${MERCHANT_PREFIX}LOW1`}
    `);
    expect(proposals).toHaveLength(0);
  });

  it("inserts a pending proposal when a merchant hits the 3x threshold in 30d", async () => {
    const merchant = `${MERCHANT_PREFIX}HIT1`;
    for (let i = 0; i < 3; i++) {
      await seedCorrection({
        merchant,
        newCategory: "alimentacion",
        externalId: `${MERCHANT_PREFIX}hit1-${i}`,
      });
    }

    const result = await detectAndEnqueueRuleProposals();

    expect(result.scanned).toBe(1);
    expect(result.inserted).toBe(1);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({
      userId: TEST_USER_ID,
      merchant,
      categorySlug: "alimentacion",
    });
    expect(typeof result.proposals[0]!.id).toBe("number");
    expect(result.proposals[0]!.id).toBeGreaterThan(0);

    const [row] = await db.execute<{
      merchant: string;
      category_slug: string;
      status: string;
      correction_txn_ids: number[];
    }>(sql`
      SELECT merchant, category_slug, status::text, correction_txn_ids
      FROM rule_proposals WHERE user_id = ${TEST_USER_ID} AND merchant = ${merchant}
    `);
    expect(row.merchant).toBe(merchant);
    expect(row.category_slug).toBe("alimentacion");
    expect(row.status).toBe("pending");
    expect(row.correction_txn_ids).toHaveLength(3);
  });

  it("excludes corrections older than 30 days from the group count", async () => {
    const merchant = `${MERCHANT_PREFIX}OLD`;
    // Two ancient corrections, one recent. Group below threshold when window applied.
    await seedCorrection({
      merchant,
      newCategory: "alimentacion",
      daysAgo: 45,
      externalId: `${MERCHANT_PREFIX}old-a`,
    });
    await seedCorrection({
      merchant,
      newCategory: "alimentacion",
      daysAgo: 40,
      externalId: `${MERCHANT_PREFIX}old-b`,
    });
    await seedCorrection({
      merchant,
      newCategory: "alimentacion",
      externalId: `${MERCHANT_PREFIX}old-c`,
    });

    const result = await detectAndEnqueueRuleProposals();

    expect(result.inserted).toBe(0);
    expect(result.proposals).toEqual([]);
  });

  it("is idempotent — running twice does not create duplicate pending proposals", async () => {
    const merchant = `${MERCHANT_PREFIX}IDEMP`;
    for (let i = 0; i < 3; i++) {
      await seedCorrection({
        merchant,
        newCategory: "alimentacion",
        externalId: `${MERCHANT_PREFIX}idemp-${i}`,
      });
    }

    const first = await detectAndEnqueueRuleProposals();
    const second = await detectAndEnqueueRuleProposals();

    expect(first.inserted).toBe(1);
    expect(first.proposals).toHaveLength(1);
    expect(second.inserted).toBe(0);
    expect(second.scanned).toBe(1);
    expect(second.proposals).toEqual([]);

    const proposals = await db.execute(sql`
      SELECT 1 FROM rule_proposals WHERE user_id = ${TEST_USER_ID} AND merchant = ${merchant}
    `);
    expect(proposals).toHaveLength(1);
  });

  it("respects 30d cooldown on denied proposals", async () => {
    const merchant = `${MERCHANT_PREFIX}DENIED`;
    // Seed a recent denial
    await db.execute(sql`
      INSERT INTO rule_proposals (user_id, merchant, category_slug, correction_txn_ids, status, decided_at)
      VALUES (
        ${TEST_USER_ID}, ${merchant}, 'alimentacion', ${JSON.stringify([1, 2, 3])}::jsonb,
        'denied', now() - interval '5 days'
      )
    `);

    for (let i = 0; i < 3; i++) {
      await seedCorrection({
        merchant,
        newCategory: "alimentacion",
        externalId: `${MERCHANT_PREFIX}denied-${i}`,
      });
    }

    const result = await detectAndEnqueueRuleProposals();
    expect(result.inserted).toBe(0);
  });

  it("re-proposes when the previous denial is older than 30 days", async () => {
    const merchant = `${MERCHANT_PREFIX}STALE-DENY`;
    await db.execute(sql`
      INSERT INTO rule_proposals (user_id, merchant, category_slug, correction_txn_ids, status, decided_at)
      VALUES (
        ${TEST_USER_ID}, ${merchant}, 'alimentacion', ${JSON.stringify([1, 2, 3])}::jsonb,
        'denied', now() - interval '40 days'
      )
    `);

    for (let i = 0; i < 3; i++) {
      await seedCorrection({
        merchant,
        newCategory: "alimentacion",
        externalId: `${MERCHANT_PREFIX}stale-deny-${i}`,
      });
    }

    const result = await detectAndEnqueueRuleProposals();
    expect(result.inserted).toBe(1);
    expect(result.proposals).toHaveLength(1);
  });

  it("proposals[] content matches the inserted rule_proposals row", async () => {
    const merchant = `${MERCHANT_PREFIX}CONTENT`;
    for (let i = 0; i < 3; i++) {
      await seedCorrection({
        merchant,
        newCategory: "alimentacion",
        externalId: `${MERCHANT_PREFIX}content-${i}`,
      });
    }

    const result = await detectAndEnqueueRuleProposals();

    expect(result.inserted).toBe(1);
    expect(result.proposals).toHaveLength(1);

    const proposal = result.proposals[0]!;
    expect(proposal.userId).toBe(TEST_USER_ID);
    expect(proposal.merchant).toBe(merchant);
    expect(proposal.categorySlug).toBe("alimentacion");
    expect(typeof proposal.id).toBe("number");
    expect(proposal.id).toBeGreaterThan(0);

    // Cross-check: the id in proposals[] must match an actual row in rule_proposals.
    const [dbRow] = await db.execute<{ id: number; merchant: string; category_slug: string }>(sql`
      SELECT id, merchant, category_slug
      FROM rule_proposals WHERE id = ${proposal.id} AND user_id = ${TEST_USER_ID}
    `);
    expect(dbRow).toBeDefined();
    expect(dbRow.id).toBe(proposal.id);
    expect(dbRow.merchant).toBe(merchant);
    expect(dbRow.category_slug).toBe("alimentacion");
  });

  it("ignores corrections with null merchant", async () => {
    const [acc] = await db.execute<{ id: number }>(sql`
      SELECT id FROM accounts WHERE name = 'Bancolombia Ahorros' LIMIT 1
    `);
    for (let i = 0; i < 3; i++) {
      const [tx] = await db.execute<{ id: number }>(sql`
        INSERT INTO transactions (
          user_id, account_id, occurred_at, amount_cents, currency, description_raw,
          merchant, classification_method, source, external_id
        ) VALUES (
          ${TEST_USER_ID}, ${acc.id}, now(), -5000, 'COP', 'test',
          NULL, 'manual'::classification_method, 'sms', ${`${MERCHANT_PREFIX}null-${i}`}
        )
        RETURNING id
      `);
      await db.execute(sql`
        INSERT INTO classification_corrections (
          user_id, transaction_id, merchant, new_category_slug
        ) VALUES (
          ${TEST_USER_ID}, ${tx.id}, NULL, 'alimentacion'
        )
      `);
    }

    const result = await detectAndEnqueueRuleProposals();
    expect(result.inserted).toBe(0);
  });
});
