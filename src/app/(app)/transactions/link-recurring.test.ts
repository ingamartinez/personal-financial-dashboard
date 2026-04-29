// #621: Integration tests for linkTxToRecurring / unlinkTxFromRecurring.
// Runs against findash_test (forced by vitest.setup.ts).
// Two-user scenarios validate tenant isolation on both actions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  recurringGaps,
  recurringTransactions,
  transactions,
  users,
} from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { copyCategorySeedsToUser, copyRuleSeedsToUser } from "@/lib/auth/signup";

// ---------------------------------------------------------------------------
// Module mocks (must be before any dynamic imports)
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Session mock — default is user 1. Override per-test with
// vi.mocked(getSessionUser).mockResolvedValueOnce({ id: X, ... })
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue({
    id: 1,
    email: "test@test.local",
    name: "Test",
    role: "user" as const,
    active: true,
  }),
}));

vi.mock("@/lib/queue", () => ({
  createQueue: vi.fn().mockReturnValue({ add: vi.fn().mockResolvedValue({ id: "mock-job" }) }),
}));

// ---------------------------------------------------------------------------
// Lazy imports (after mocks)
// ---------------------------------------------------------------------------

const { linkTxToRecurring, unlinkTxFromRecurring } = await import("./actions");
const { getSessionUser } = await import("@/lib/auth/session");
const mockGetSessionUser = vi.mocked(getSessionUser);

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const TAG = "test-link-621";

async function seedUser(email: string): Promise<number> {
  const [row] = await db.insert(users).values({ email, name: email }).returning({ id: users.id });
  await copyCategorySeedsToUser(row.id);
  await copyRuleSeedsToUser(row.id);
  return row.id;
}

async function seedAccount(userId: number): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG}-account`,
      institution: TAG,
      type: "savings",
      currency: "COP",
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function seedRecurring(userId: number, accountId: number): Promise<number> {
  const [row] = await db
    .insert(recurringTransactions)
    .values({
      userId,
      accountId,
      label: `${TAG}-recurring`,
      amountCents: BigInt(-150000),
      currency: "COP",
      dayOfMonth: 5,
      active: true,
    })
    .returning({ id: recurringTransactions.id });
  return row.id;
}

async function seedTx(
  userId: number,
  accountId: number,
  opts: { recurringId?: number; recurringYearMonth?: string } = {},
): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      accountId,
      occurredAt: new Date("2026-03-05T12:00:00Z"),
      amountCents: BigInt(-150000),
      currency: "COP",
      descriptionRaw: `${TAG}-tx`,
      classificationMethod: "unclassified",
      source: "manual",
      recurringId: opts.recurringId ?? null,
      recurringYearMonth: opts.recurringYearMonth ?? null,
    })
    .returning({ id: transactions.id });
  return row.id;
}

async function seedGap(userId: number, recurringId: number, yearMonth: string): Promise<number> {
  const [row] = await db
    .insert(recurringGaps)
    .values({ userId, recurringId, yearMonth })
    .returning({ id: recurringGaps.id });
  return row.id;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanup() {
  // Order matters: FK tx → recurring_gaps, transactions → recurring_transactions, accounts, users
  await db.execute(sql`
    DELETE FROM recurring_gaps
    WHERE recurring_id IN (
      SELECT id FROM recurring_transactions WHERE label = ${TAG + "-recurring"}
    )
  `);
  await db.execute(sql`
    DELETE FROM transactions WHERE description_raw = ${TAG + "-tx"}
  `);
  await db.execute(sql`
    DELETE FROM recurring_transactions WHERE label = ${TAG + "-recurring"}
  `);
  await db.execute(sql`
    DELETE FROM accounts WHERE name = ${TAG + "-account"}
  `);
  await db.execute(sql`
    DELETE FROM users WHERE email LIKE ${TAG + "%"}
  `);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("linkTxToRecurring", () => {
  let userAId: number;
  let accountAId: number;
  let recurringAId: number;

  beforeEach(async () => {
    await cleanup();
    userAId = await seedUser(`${TAG}-userA@test.local`);
    accountAId = await seedAccount(userAId);
    recurringAId = await seedRecurring(userAId, accountAId);
    mockGetSessionUser.mockResolvedValue({
      id: userAId,
      email: `${TAG}-userA@test.local`,
      name: "A",
      role: "user" as const,
      active: true,
    });
  });

  afterEach(cleanup);

  it("happy path: links tx, sets recurring fields, closes open gap", async () => {
    const txId = await seedTx(userAId, accountAId);
    const gapId = await seedGap(userAId, recurringAId, "2026-03");

    const result = await linkTxToRecurring({ txId, recurringId: recurringAId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("should not reach");
    expect(result.yearMonth).toBe("2026-03"); // derived from tx.occurredAt

    // Tx fields updated
    const [tx] = await db
      .select({
        recurringId: transactions.recurringId,
        recurringYearMonth: transactions.recurringYearMonth,
      })
      .from(transactions)
      .where(and(eq(transactions.id, txId), notDeleted(transactions.deletedAt)));
    expect(tx?.recurringId).toBe(recurringAId);
    expect(tx?.recurringYearMonth).toBe("2026-03");

    // Gap closed with resolution
    const [gap] = await db
      .select({
        resolution: recurringGaps.resolution,
        resolutionTxId: recurringGaps.resolutionTxId,
      })
      .from(recurringGaps)
      .where(eq(recurringGaps.id, gapId));
    expect(gap?.resolution).toBe("linked");
    expect(gap?.resolutionTxId).toBe(txId);
  });

  it("rejects if tx already has recurring_id", async () => {
    const txId = await seedTx(userAId, accountAId, {
      recurringId: recurringAId,
      recurringYearMonth: "2026-02",
    });

    const result = await linkTxToRecurring({ txId, recurringId: recurringAId });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should not reach");
    expect(result.error).toMatch(/ya tiene un recurring/i);
  });

  it("rejects if recurring slot already covered by another tx", async () => {
    // First tx covers the slot
    const firstTxId = await seedTx(userAId, accountAId, {
      recurringId: recurringAId,
      recurringYearMonth: "2026-03",
    });
    // Second tx (unlinked) tries to claim the same slot
    const secondTxId = await seedTx(userAId, accountAId);

    const result = await linkTxToRecurring({
      txId: secondTxId,
      recurringId: recurringAId,
      yearMonth: "2026-03",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should not reach");
    expect(result.error).toMatch(/ya está cubierto/i);

    // Ensure firstTxId is cleaned up too
    await db.execute(sql`DELETE FROM transactions WHERE id = ${firstTxId}`);
  });

  it("cross-tenant: userA cannot link their tx to userB recurring", async () => {
    const userBId = await seedUser(`${TAG}-userB@test.local`);
    const accountBId = await seedAccount(userBId);
    const recurringBId = await seedRecurring(userBId, accountBId);

    // Session is userA, but we try to link to userB's recurring
    const txId = await seedTx(userAId, accountAId);
    const result = await linkTxToRecurring({ txId, recurringId: recurringBId });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should not reach");
    expect(result.error).toMatch(/no encontrado|no pertenece/i);

    // Cleanup userB data
    await db.execute(sql`DELETE FROM recurring_transactions WHERE id = ${recurringBId}`);
    await db.execute(sql`DELETE FROM accounts WHERE id = ${accountBId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userBId}`);
  });

  it("uses provided yearMonth instead of deriving from tx.occurredAt", async () => {
    const txId = await seedTx(userAId, accountAId);

    const result = await linkTxToRecurring({
      txId,
      recurringId: recurringAId,
      yearMonth: "2026-02",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("should not reach");
    expect(result.yearMonth).toBe("2026-02");

    const [tx] = await db
      .select({ recurringYearMonth: transactions.recurringYearMonth })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(tx?.recurringYearMonth).toBe("2026-02");
  });
});

describe("unlinkTxFromRecurring", () => {
  let userAId: number;
  let accountAId: number;
  let recurringAId: number;

  beforeEach(async () => {
    await cleanup();
    userAId = await seedUser(`${TAG}-userA@test.local`);
    accountAId = await seedAccount(userAId);
    recurringAId = await seedRecurring(userAId, accountAId);
    mockGetSessionUser.mockResolvedValue({
      id: userAId,
      email: `${TAG}-userA@test.local`,
      name: "A",
      role: "user" as const,
      active: true,
    });
  });

  afterEach(cleanup);

  it("happy path: clears recurring_id and recurring_year_month", async () => {
    const txId = await seedTx(userAId, accountAId, {
      recurringId: recurringAId,
      recurringYearMonth: "2026-03",
    });

    const result = await unlinkTxFromRecurring({ txId });
    expect(result.ok).toBe(true);

    const [tx] = await db
      .select({
        recurringId: transactions.recurringId,
        recurringYearMonth: transactions.recurringYearMonth,
      })
      .from(transactions)
      .where(eq(transactions.id, txId));
    expect(tx?.recurringId).toBeNull();
    expect(tx?.recurringYearMonth).toBeNull();
  });

  it("idempotent: calling unlink on a tx without a link returns ok without error", async () => {
    const txId = await seedTx(userAId, accountAId); // not linked

    const result = await unlinkTxFromRecurring({ txId });
    expect(result.ok).toBe(true);
  });

  it("cross-tenant: userA cannot unlink a tx that belongs to userB", async () => {
    const userBId = await seedUser(`${TAG}-userB@test.local`);
    const accountBId = await seedAccount(userBId);
    const recurringBId = await seedRecurring(userBId, accountBId);

    // Insert a tx belonging to userB with a link
    const [txBRow] = await db
      .insert(transactions)
      .values({
        userId: userBId,
        accountId: accountBId,
        occurredAt: new Date("2026-03-05T12:00:00Z"),
        amountCents: BigInt(-150000),
        currency: "COP",
        descriptionRaw: `${TAG}-tx`,
        classificationMethod: "unclassified",
        source: "manual",
        recurringId: recurringBId,
        recurringYearMonth: "2026-03",
      })
      .returning({ id: transactions.id });
    const txBId = txBRow.id;

    // Session is userA — should not be able to unlink userB's tx
    const result = await unlinkTxFromRecurring({ txId: txBId });

    // The action fetches the tx with user_id = userA — so it won't find it.
    // It returns { ok: false, error: "Transacción no encontrada" }
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should not reach");
    expect(result.error).toMatch(/no encontrada/i);

    // Cleanup userB
    await db.execute(sql`DELETE FROM transactions WHERE id = ${txBId}`);
    await db.execute(sql`DELETE FROM recurring_transactions WHERE id = ${recurringBId}`);
    await db.execute(sql`DELETE FROM accounts WHERE id = ${accountBId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userBId}`);
  });
});
