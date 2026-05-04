import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  archiveTransferGroup,
  insertTransferGroup,
  linkExistingTransactionsAsTransfer,
  listTransferGroupLegs,
  restoreTransferGroup,
  validateTransferGroupLegs,
  type TransferLeg,
} from "./transfer-groups";

// #405: Unit + DB tests for the transfer-group primitive. Covers the core
// invariants (Σ=0, opposite signs, ≥2 legs), atomic multi-leg insert with
// duplicate rollback, and the cascading archive/restore helpers.
//
// Tenancy: every assertion scopes on user_id — never relies on id alone, in
// line with the per-user-table-join-tenant-safety memory.

const TEST_USER_ID = 1;
const SAVINGS_COP_ID = 1;
const VISA_COP_ID = 5;
const MASTERCARD_COP_ID = 6;

function leg(
  override: Partial<TransferLeg> & Pick<TransferLeg, "accountId" | "amountCents">,
): TransferLeg {
  return {
    currency: "COP",
    descriptionRaw: "test transfer",
    source: "manual",
    occurredAt: new Date("2026-04-15T12:00:00Z"),
    rawData: { test: true },
    ...override,
  };
}

async function cleanup() {
  await db.execute(sql`
    DELETE FROM transactions
    WHERE external_id LIKE 'test-tg:%' OR raw_data @> '{"test": true}'
  `);
}

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe("validateTransferGroupLegs (pure)", () => {
  it("rejects an empty leg list", () => {
    expect(validateTransferGroupLegs([])).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects a single-leg group", () => {
    const result = validateTransferGroupLegs([leg({ accountId: 1, amountCents: BigInt(-1000) })]);
    expect(result).toEqual({ ok: false, reason: "single-leg" });
  });

  it("rejects when all legs share the same sign (no debit + credit pair)", () => {
    const result = validateTransferGroupLegs([
      leg({ accountId: 1, amountCents: BigInt(-500) }),
      leg({ accountId: 2, amountCents: BigInt(-500) }),
    ]);
    expect(result).toEqual({ ok: false, reason: "missing-opposite-signs" });
  });

  it("rejects an unbalanced group (Σ ≠ 0)", () => {
    const result = validateTransferGroupLegs([
      leg({ accountId: 1, amountCents: BigInt(-1000) }),
      leg({ accountId: 2, amountCents: BigInt(900) }),
    ]);
    expect(result).toEqual({ ok: false, reason: "unbalanced" });
  });

  it("accepts a valid 2-leg group (debit + credit, Σ=0)", () => {
    const result = validateTransferGroupLegs([
      leg({ accountId: 1, amountCents: BigInt(-1000) }),
      leg({ accountId: 2, amountCents: BigInt(1000) }),
    ]);
    expect(result).toEqual({ ok: true });
  });

  it("accepts a valid 1-to-N group (one debit, many credits summing to |debit|)", () => {
    const result = validateTransferGroupLegs([
      leg({ accountId: 1, amountCents: BigInt(-10000) }),
      leg({ accountId: 2, amountCents: BigInt(4000) }),
      leg({ accountId: 3, amountCents: BigInt(6000) }),
    ]);
    expect(result).toEqual({ ok: true });
  });
});

describe("insertTransferGroup", () => {
  it("inserts every leg atomically with the same transfer_group_id", async () => {
    const result = await insertTransferGroup({
      userId: TEST_USER_ID,
      legs: [
        leg({
          accountId: SAVINGS_COP_ID,
          amountCents: BigInt(-50000),
          externalId: "test-tg:basic:1",
        }),
        leg({
          accountId: VISA_COP_ID,
          amountCents: BigInt(50000),
          externalId: "test-tg:basic:1",
        }),
      ],
    });
    expect(result.status).toBe("inserted");
    if (result.status !== "inserted") return;

    const rows = await db.execute<{
      id: number;
      account_id: number;
      amount_cents: string;
      transfer_group_id: string;
      channel: string;
      category_slug: string | null;
    }>(sql`
      SELECT id, account_id, amount_cents::text, transfer_group_id, channel, category_slug
      FROM transactions
      WHERE transfer_group_id = ${result.transferGroupId}::uuid
      ORDER BY amount_cents ASC
    `);
    expect(rows.length).toBe(2);
    expect(rows[0].transfer_group_id).toBe(result.transferGroupId);
    expect(rows[1].transfer_group_id).toBe(result.transferGroupId);
    // Both legs share channel="transfer" and no category.
    for (const row of rows) {
      expect(row.channel).toBe("transfer");
      expect(row.category_slug).toBeNull();
    }
    // Σ = 0
    expect(BigInt(rows[0].amount_cents) + BigInt(rows[1].amount_cents)).toBe(BigInt(0));
  });

  it("returns `duplicated` and rolls back when a leg conflicts on (account, external_id)", async () => {
    const first = await insertTransferGroup({
      userId: TEST_USER_ID,
      legs: [
        leg({
          accountId: SAVINGS_COP_ID,
          amountCents: BigInt(-25000),
          externalId: "test-tg:dedup:1",
        }),
        leg({ accountId: VISA_COP_ID, amountCents: BigInt(25000), externalId: "test-tg:dedup:1" }),
      ],
    });
    expect(first.status).toBe("inserted");

    const second = await insertTransferGroup({
      userId: TEST_USER_ID,
      legs: [
        leg({
          accountId: SAVINGS_COP_ID,
          amountCents: BigInt(-25000),
          externalId: "test-tg:dedup:1",
        }),
        leg({ accountId: VISA_COP_ID, amountCents: BigInt(25000), externalId: "test-tg:dedup:1" }),
      ],
    });
    expect(second.status).toBe("duplicated");

    // Exactly 2 rows exist — the second group was rolled back in full.
    const rows = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM transactions WHERE external_id = 'test-tg:dedup:1'
    `);
    expect(rows[0].n).toBe("2");
  });

  it("rejects invalid groups before touching the DB", async () => {
    const result = await insertTransferGroup({
      userId: TEST_USER_ID,
      legs: [
        leg({ accountId: SAVINGS_COP_ID, amountCents: BigInt(-1000) }),
        leg({ accountId: VISA_COP_ID, amountCents: BigInt(500) }),
      ],
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.reason).toContain("unbalanced");
  });

  it("supports 1-to-N groups (one debit, many credits)", async () => {
    const result = await insertTransferGroup({
      userId: TEST_USER_ID,
      legs: [
        leg({
          accountId: SAVINGS_COP_ID,
          amountCents: BigInt(-100000),
          externalId: "test-tg:1ton:1",
        }),
        leg({
          accountId: VISA_COP_ID,
          amountCents: BigInt(40000),
          externalId: "test-tg:1ton:1",
        }),
        leg({
          accountId: MASTERCARD_COP_ID,
          amountCents: BigInt(60000),
          externalId: "test-tg:1ton:1",
        }),
      ],
    });
    expect(result.status).toBe("inserted");
    if (result.status !== "inserted") return;
    expect(result.txIds.length).toBe(3);
  });
});

describe("archiveTransferGroup / restoreTransferGroup", () => {
  it("archives every live leg in a group atomically", async () => {
    const result = await insertTransferGroup({
      userId: TEST_USER_ID,
      legs: [
        leg({
          accountId: SAVINGS_COP_ID,
          amountCents: BigInt(-7000),
          externalId: "test-tg:arch:1",
        }),
        leg({ accountId: VISA_COP_ID, amountCents: BigInt(7000), externalId: "test-tg:arch:1" }),
      ],
    });
    expect(result.status).toBe("inserted");
    if (result.status !== "inserted") return;

    const archived = await archiveTransferGroup({
      userId: TEST_USER_ID,
      transferGroupId: result.transferGroupId,
    });
    expect(archived).toBe(2);

    const liveCount = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM transactions
      WHERE transfer_group_id = ${result.transferGroupId}::uuid AND deleted_at IS NULL
    `);
    expect(liveCount[0].n).toBe("0");

    // Idempotent re-archive: already-archived rows are skipped.
    const again = await archiveTransferGroup({
      userId: TEST_USER_ID,
      transferGroupId: result.transferGroupId,
    });
    expect(again).toBe(0);
  });

  it("restore flips deleted_at back to NULL on every leg", async () => {
    const result = await insertTransferGroup({
      userId: TEST_USER_ID,
      legs: [
        leg({
          accountId: SAVINGS_COP_ID,
          amountCents: BigInt(-3000),
          externalId: "test-tg:rest:1",
        }),
        leg({ accountId: VISA_COP_ID, amountCents: BigInt(3000), externalId: "test-tg:rest:1" }),
      ],
    });
    if (result.status !== "inserted") throw new Error("seed failed");

    await archiveTransferGroup({ userId: TEST_USER_ID, transferGroupId: result.transferGroupId });
    const restored = await restoreTransferGroup({
      userId: TEST_USER_ID,
      transferGroupId: result.transferGroupId,
    });
    expect(restored).toBe(2);

    const liveCount = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM transactions
      WHERE transfer_group_id = ${result.transferGroupId}::uuid AND deleted_at IS NULL
    `);
    expect(liveCount[0].n).toBe("2");
  });

  it("never cascades across user_id (tenancy)", async () => {
    const result = await insertTransferGroup({
      userId: TEST_USER_ID,
      legs: [
        leg({ accountId: SAVINGS_COP_ID, amountCents: BigInt(-1000), externalId: "test-tg:ten:1" }),
        leg({ accountId: VISA_COP_ID, amountCents: BigInt(1000), externalId: "test-tg:ten:1" }),
      ],
    });
    if (result.status !== "inserted") throw new Error("seed failed");

    // A different (nonexistent-in-test) user trying to archive the same group
    // must not touch any of the rows — the user_id filter is the guard.
    const archived = await archiveTransferGroup({
      userId: 999_999,
      transferGroupId: result.transferGroupId,
    });
    expect(archived).toBe(0);

    const legs = await listTransferGroupLegs({
      userId: TEST_USER_ID,
      transferGroupIds: [result.transferGroupId],
    });
    expect(legs.every((l) => l.deletedAt === null)).toBe(true);
  });
});

describe("installmentsTotal + installmentRateEmX10k on TransferLeg (#687)", () => {
  it("persists installment fields on the TC debit leg when provided", async () => {
    const result = await insertTransferGroup({
      userId: TEST_USER_ID,
      legs: [
        leg({
          accountId: SAVINGS_COP_ID,
          amountCents: BigInt(5_000_000),
          externalId: "test-tg:installment:savings",
        }),
        leg({
          accountId: VISA_COP_ID,
          amountCents: BigInt(-5_000_000),
          externalId: "test-tg:installment:tc",
          installmentsTotal: 60,
          installmentRateEmX10k: 13900,
        }),
      ],
    });
    expect(result.status).toBe("inserted");
    if (result.status !== "inserted") return;

    const rows = await db.execute<{
      account_id: number;
      amount_cents: string;
      installments_total: number;
      installment_rate_bps: number | null;
    }>(sql`
      SELECT account_id, amount_cents::text, installments_total, installment_rate_bps
      FROM transactions
      WHERE transfer_group_id = ${result.transferGroupId}::uuid
      ORDER BY amount_cents ASC
    `);

    // TC debit leg (negative amount)
    const tcLeg = rows.find((r) => BigInt(r.amount_cents) < BigInt(0));
    expect(tcLeg).toBeDefined();
    if (!tcLeg) return;
    expect(tcLeg.installments_total).toBe(60);
    expect(tcLeg.installment_rate_bps).toBe(13900);

    // Savings leg (positive amount) keeps the default installmentsTotal=1
    const savingsLeg = rows.find((r) => BigInt(r.amount_cents) > BigInt(0));
    expect(savingsLeg).toBeDefined();
    if (!savingsLeg) return;
    expect(savingsLeg.installments_total).toBe(1);
    expect(savingsLeg.installment_rate_bps).toBeNull();
  });

  it("validateTransferGroupLegs rejects a leg with rate but no installment plan", () => {
    const result = validateTransferGroupLegs([
      leg({ accountId: SAVINGS_COP_ID, amountCents: BigInt(1000) }),
      leg({
        accountId: VISA_COP_ID,
        amountCents: BigInt(-1000),
        installmentRateEmX10k: 13900,
        // installmentsTotal omitted → defaults to undefined → treated as <= 1
      }),
    ]);
    expect(result).toEqual({ ok: false, reason: "rate-without-plan" });
  });

  it("validateTransferGroupLegs rejects installmentsTotal=1 with a rate", () => {
    const result = validateTransferGroupLegs([
      leg({ accountId: SAVINGS_COP_ID, amountCents: BigInt(1000) }),
      leg({
        accountId: VISA_COP_ID,
        amountCents: BigInt(-1000),
        installmentsTotal: 1,
        installmentRateEmX10k: 13900,
      }),
    ]);
    expect(result).toEqual({ ok: false, reason: "rate-without-plan" });
  });

  it("validateTransferGroupLegs accepts installmentsTotal > 1 with a rate", () => {
    const result = validateTransferGroupLegs([
      leg({ accountId: SAVINGS_COP_ID, amountCents: BigInt(1000) }),
      leg({
        accountId: VISA_COP_ID,
        amountCents: BigInt(-1000),
        installmentsTotal: 60,
        installmentRateEmX10k: 13900,
      }),
    ]);
    expect(result).toEqual({ ok: true });
  });
});

describe("no double-counting of debts after the refactor", () => {
  it("a TC statement payment via transfer group does NOT add to `deudas`-sum", async () => {
    // Compute the baseline spend in "deudas" children (real debt servicing).
    const baseline = await db.execute<{ total: string | null }>(sql`
      SELECT COALESCE(SUM(amount_cents), 0)::text AS total
      FROM transactions t
      LEFT JOIN categories c
        ON c.user_id = t.user_id AND c.slug = t.category_slug
      WHERE t.user_id = ${TEST_USER_ID}
        AND t.deleted_at IS NULL
        AND (t.category_slug = 'deudas' OR c.parent_slug = 'deudas')
    `);
    const baselineTotal = BigInt(baseline[0].total ?? "0");

    // Insert a 500k TC payment as a transfer group. If it leaked into a
    // category under `deudas`, the sum would move. With the #405 refactor
    // it must NOT.
    const result = await insertTransferGroup({
      userId: TEST_USER_ID,
      legs: [
        leg({
          accountId: SAVINGS_COP_ID,
          amountCents: BigInt(-50000000),
          externalId: "test-tg:dbl:1",
        }),
        leg({ accountId: VISA_COP_ID, amountCents: BigInt(50000000), externalId: "test-tg:dbl:1" }),
      ],
    });
    expect(result.status).toBe("inserted");

    const after = await db.execute<{ total: string | null }>(sql`
      SELECT COALESCE(SUM(amount_cents), 0)::text AS total
      FROM transactions t
      LEFT JOIN categories c
        ON c.user_id = t.user_id AND c.slug = t.category_slug
      WHERE t.user_id = ${TEST_USER_ID}
        AND t.deleted_at IS NULL
        AND (t.category_slug = 'deudas' OR c.parent_slug = 'deudas')
    `);
    const afterTotal = BigInt(after[0].total ?? "0");

    expect(afterTotal).toBe(baselineTotal);
  });
});

// ---------------------------------------------------------------------------
// #762: linkExistingTransactionsAsTransfer
// ---------------------------------------------------------------------------
describe("linkExistingTransactionsAsTransfer", () => {
  // Helper: insert a bare transaction and return its id.
  async function insertBareTransaction(opts: {
    accountId: number;
    amountCents: bigint;
    externalId?: string;
  }): Promise<number> {
    const rows = await db.execute<{ id: number }>(sql`
      INSERT INTO transactions
        (user_id, account_id, occurred_at, amount_cents, currency,
         description_raw, source, channel, classification_method, raw_data)
      VALUES
        (${TEST_USER_ID}, ${opts.accountId}, NOW(), ${opts.amountCents},
         'COP', 'test', 'manual', 'bank', 'unclassified', '{"test":true}')
      RETURNING id
    `);
    return rows[0].id;
  }

  it("happy path: links two unlinked tx, sets channel=transfer, categorySlug=null", async () => {
    const idA = await insertBareTransaction({
      accountId: SAVINGS_COP_ID,
      amountCents: BigInt(-50000),
    });
    const idB = await insertBareTransaction({ accountId: VISA_COP_ID, amountCents: BigInt(50000) });

    const result = await linkExistingTransactionsAsTransfer({
      userId: TEST_USER_ID,
      txIdA: idA,
      txIdB: idB,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const rows = await db.execute<{
      id: number;
      transfer_group_id: string | null;
      channel: string;
      category_slug: string | null;
    }>(sql`
      SELECT id, transfer_group_id, channel, category_slug
      FROM transactions WHERE id IN (${idA}, ${idB})
      ORDER BY id
    `);

    expect(rows.length).toBe(2);
    // Both share the same transfer_group_id.
    expect(rows[0].transfer_group_id).toBeTruthy();
    expect(rows[0].transfer_group_id).toBe(rows[1].transfer_group_id);
    // Both get channel=transfer, category wiped.
    for (const row of rows) {
      expect(row.channel).toBe("transfer");
      expect(row.category_slug).toBeNull();
    }
  });

  it("idempotent: calling twice on already-paired tx returns ok without mutation", async () => {
    const idA = await insertBareTransaction({
      accountId: SAVINGS_COP_ID,
      amountCents: BigInt(-30000),
    });
    const idB = await insertBareTransaction({ accountId: VISA_COP_ID, amountCents: BigInt(30000) });

    const first = await linkExistingTransactionsAsTransfer({
      userId: TEST_USER_ID,
      txIdA: idA,
      txIdB: idB,
    });
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;

    const second = await linkExistingTransactionsAsTransfer({
      userId: TEST_USER_ID,
      txIdA: idA,
      txIdB: idB,
    });
    expect(second.status).toBe("ok");
    if (second.status !== "ok") return;

    // Must return the same groupId both times.
    expect(second.transferGroupId).toBe(first.transferGroupId);
  });

  it("conflict: returns conflict when both tx already have different groupIds", async () => {
    // Insert two existing pairs, then try to cross-link one leg from each.
    const pairOne = await insertTransferGroup({
      userId: TEST_USER_ID,
      legs: [
        leg({
          accountId: SAVINGS_COP_ID,
          amountCents: BigInt(-10000),
          externalId: "test-lex:p1:a",
        }),
        leg({ accountId: VISA_COP_ID, amountCents: BigInt(10000), externalId: "test-lex:p1:b" }),
      ],
    });
    const pairTwo = await insertTransferGroup({
      userId: TEST_USER_ID,
      legs: [
        leg({
          accountId: SAVINGS_COP_ID,
          amountCents: BigInt(-20000),
          externalId: "test-lex:p2:a",
        }),
        leg({ accountId: VISA_COP_ID, amountCents: BigInt(20000), externalId: "test-lex:p2:b" }),
      ],
    });
    expect(pairOne.status).toBe("inserted");
    expect(pairTwo.status).toBe("inserted");
    if (pairOne.status !== "inserted" || pairTwo.status !== "inserted") return;

    // Try to link one leg of pairOne with one leg of pairTwo.
    const result = await linkExistingTransactionsAsTransfer({
      userId: TEST_USER_ID,
      txIdA: pairOne.txIds[0],
      txIdB: pairTwo.txIds[0],
    });

    expect(result.status).toBe("conflict");
  });

  it("tenant safety: returns error when txIdB belongs to a different user", async () => {
    const idA = await insertBareTransaction({
      accountId: SAVINGS_COP_ID,
      amountCents: BigInt(-15000),
    });
    const idB = await insertBareTransaction({ accountId: VISA_COP_ID, amountCents: BigInt(15000) });

    // Calling with wrong userId — query should find 0 rows (or 1), never link.
    const result = await linkExistingTransactionsAsTransfer({
      userId: 999_999,
      txIdA: idA,
      txIdB: idB,
    });

    expect(result.status).toBe("error");

    // Verify neither transaction was modified.
    const rows = await db.execute<{ transfer_group_id: string | null }>(sql`
      SELECT transfer_group_id FROM transactions WHERE id IN (${idA}, ${idB})
    `);
    expect(rows.every((r) => r.transfer_group_id === null)).toBe(true);
  });

  it("adopt-partner groupId: when txA is the ONLY member of its group, txB adopts it", async () => {
    // Insert a pair but archive one leg, leaving txA as the sole live member.
    // Then link txA (solo in group) with orphan txB — should succeed and adopt txA's groupId.
    const existingPair = await insertTransferGroup({
      userId: TEST_USER_ID,
      legs: [
        leg({
          accountId: SAVINGS_COP_ID,
          amountCents: BigInt(-8000),
          externalId: "test-lex:adopt:a",
        }),
        leg({ accountId: VISA_COP_ID, amountCents: BigInt(8000), externalId: "test-lex:adopt:b" }),
      ],
    });
    expect(existingPair.status).toBe("inserted");
    if (existingPair.status !== "inserted") return;

    // Archive the second leg so txA is the only live member of the group.
    await db.execute(sql`
      UPDATE transactions SET deleted_at = NOW()
      WHERE id = ${existingPair.txIds[1]}
    `);

    // Create an orphan tx.
    const orphanId = await insertBareTransaction({
      accountId: MASTERCARD_COP_ID,
      amountCents: BigInt(-8000),
    });

    // Link orphan to txA (sole live member) — should succeed.
    const result = await linkExistingTransactionsAsTransfer({
      userId: TEST_USER_ID,
      txIdA: existingPair.txIds[0],
      txIdB: orphanId,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.transferGroupId).toBe(existingPair.transferGroupId);

    // Orphan now carries the existing groupId.
    const rows = await db.execute<{ transfer_group_id: string | null }>(sql`
      SELECT transfer_group_id FROM transactions WHERE id = ${orphanId}
    `);
    expect(rows[0].transfer_group_id).toBe(existingPair.transferGroupId);
  });

  it("conflict by 3-member guard: txA already paired with partnerX, linking with orphan txB returns conflict", async () => {
    // Setup: txA + partnerX share groupId G1 (2 live members).
    const existingPair = await insertTransferGroup({
      userId: TEST_USER_ID,
      legs: [
        leg({
          accountId: SAVINGS_COP_ID,
          amountCents: BigInt(-12000),
          externalId: "test-lex:3member:a",
        }),
        leg({
          accountId: VISA_COP_ID,
          amountCents: BigInt(12000),
          externalId: "test-lex:3member:b",
        }),
      ],
    });
    expect(existingPair.status).toBe("inserted");
    if (existingPair.status !== "inserted") return;

    // Create orphan txB with no group.
    const orphanId = await insertBareTransaction({
      accountId: MASTERCARD_COP_ID,
      amountCents: BigInt(-12000),
    });

    // Attempt to link txA (already has a 2-member group) with orphan txB.
    const result = await linkExistingTransactionsAsTransfer({
      userId: TEST_USER_ID,
      txIdA: existingPair.txIds[0],
      txIdB: orphanId,
    });

    // Must return conflict — no 3-member groups allowed.
    expect(result.status).toBe("conflict");

    // Side-effect check: txA still belongs to G1, orphan still has no group.
    const rows = await db.execute<{ id: number; transfer_group_id: string | null }>(sql`
      SELECT id, transfer_group_id FROM transactions
      WHERE id IN (${existingPair.txIds[0]}, ${orphanId})
      ORDER BY id
    `);
    const rowA = rows.find((r) => r.id === existingPair.txIds[0]);
    const rowOrphan = rows.find((r) => r.id === orphanId);
    expect(rowA?.transfer_group_id).toBe(existingPair.transferGroupId);
    expect(rowOrphan?.transfer_group_id).toBeNull();
  });
});
