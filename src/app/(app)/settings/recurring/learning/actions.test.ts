// #633: Integration tests for acceptProposal / rejectProposal server actions.
// Runs against findash_test (forced by vitest.setup.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  recurringLinkObservations,
  recurringProposals,
  recurringTransactions,
  transactions,
  users,
} from "@/lib/db/schema";
import { copyCategorySeedsToUser, copyRuleSeedsToUser } from "@/lib/auth/signup";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue({
    id: 1,
    email: "test@test.local",
    name: "Test",
    role: "user" as const,
    active: true,
  }),
}));

// ---------------------------------------------------------------------------
// Lazy imports (after mocks)
// ---------------------------------------------------------------------------

const { acceptProposal, rejectProposal, countPendingProposals } = await import("./actions");
const { getSessionUser } = await import("@/lib/auth/session");
const mockGetSessionUser = vi.mocked(getSessionUser);

// ---------------------------------------------------------------------------
// Test data tag and seed helpers
// ---------------------------------------------------------------------------

const TAG = "test-proposal-actions-633";

async function seedUser(email: string): Promise<number> {
  const [row] = await db.insert(users).values({ email, name: email }).returning({ id: users.id });
  await copyCategorySeedsToUser(row.id);
  await copyRuleSeedsToUser(row.id);
  return row.id;
}

async function seedAccount(userId: number): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({ userId, name: `${TAG}-acct`, institution: TAG, type: "savings", currency: "COP" })
    .returning({ id: accounts.id });
  return row.id;
}

async function seedRecurring(
  userId: number,
  accountId: number,
  amountCents: bigint = BigInt(-42000),
): Promise<number> {
  const [row] = await db
    .insert(recurringTransactions)
    .values({
      userId,
      accountId,
      label: `${TAG}-recurring`,
      amountCents,
      currency: "COP",
      dayOfMonth: 15,
      active: true,
    })
    .returning({ id: recurringTransactions.id });
  return row.id;
}

async function seedTx(userId: number, accountId: number): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      accountId,
      occurredAt: new Date("2026-04-15T12:00:00Z"),
      amountCents: BigInt(-44900),
      currency: "COP",
      descriptionRaw: `${TAG}-tx`,
      classificationMethod: "unclassified",
      source: "manual",
    })
    .returning({ id: transactions.id });
  return row.id;
}

async function seedProposal(
  userId: number,
  recurringId: number,
  proposalType: "amount_update" | "variable_flag",
  payload: Record<string, unknown> = {},
): Promise<number> {
  const [row] = await db
    .insert(recurringProposals)
    .values({ userId, recurringId, proposalType, payload, status: "pending" })
    .returning({ id: recurringProposals.id });
  return row.id;
}

async function seedObservation(
  userId: number,
  recurringId: number,
  txId: number,
  accountId: number,
): Promise<void> {
  await db.insert(recurringLinkObservations).values({
    userId,
    recurringId,
    txId,
    yearMonth: "2026-04",
    realAmountCents: BigInt(-44900),
    realCurrency: "COP",
    descriptionRaw: `${TAG}-tx`,
    accountId,
    manual: true,
    applied: false,
  });
}

async function cleanup() {
  await db.execute(
    sql`DELETE FROM recurring_link_observations WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})`,
  );
  await db.execute(
    sql`DELETE FROM recurring_proposals WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})`,
  );
  await db.execute(sql`DELETE FROM transactions WHERE description_raw = ${TAG + "-tx"}`);
  await db.execute(sql`DELETE FROM recurring_transactions WHERE label = ${TAG + "-recurring"}`);
  await db.execute(sql`DELETE FROM accounts WHERE name = ${TAG + "-acct"}`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${TAG + "%"}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("acceptProposal (amount_update)", () => {
  let userAId: number;
  let accountAId: number;
  let recurringAId: number;

  beforeEach(async () => {
    await cleanup();
    userAId = await seedUser(`${TAG}-userA@test.local`);
    accountAId = await seedAccount(userAId);
    recurringAId = await seedRecurring(userAId, accountAId, BigInt(-42000));
    mockGetSessionUser.mockResolvedValue({
      id: userAId,
      email: `${TAG}-userA@test.local`,
      name: "A",
      role: "user" as const,
      active: true,
    });
  });

  afterEach(cleanup);

  it("updates recurring.amount_cents and marks proposal accepted + observations applied", async () => {
    const txId = await seedTx(userAId, accountAId);
    await seedObservation(userAId, recurringAId, txId, accountAId);

    const proposalId = await seedProposal(userAId, recurringAId, "amount_update", {
      newAmountCents: "-44900",
      oldAmountCents: "-42000",
      currency: "COP",
      observationCount: 2,
    });

    const result = await acceptProposal({ proposalId });

    expect(result.ok).toBe(true);

    // Recurring amount updated.
    const [rt] = await db
      .select({ amountCents: recurringTransactions.amountCents })
      .from(recurringTransactions)
      .where(eq(recurringTransactions.id, recurringAId));

    expect(rt?.amountCents.toString()).toBe("-44900");

    // Proposal accepted.
    const [p] = await db
      .select({ status: recurringProposals.status })
      .from(recurringProposals)
      .where(eq(recurringProposals.id, proposalId));

    expect(p?.status).toBe("accepted");

    // Observations applied.
    const [obs] = await db
      .select({ applied: recurringLinkObservations.applied })
      .from(recurringLinkObservations)
      .where(
        and(
          eq(recurringLinkObservations.userId, userAId),
          eq(recurringLinkObservations.recurringId, recurringAId),
        ),
      );

    expect(obs?.applied).toBe(true);
  });

  it("returns ok:false if proposal already accepted", async () => {
    const proposalId = await seedProposal(userAId, recurringAId, "amount_update", {});
    // Mark as already accepted.
    await db
      .update(recurringProposals)
      .set({ status: "accepted", decidedAt: new Date() })
      .where(eq(recurringProposals.id, proposalId));

    const result = await acceptProposal({ proposalId });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should not reach");
    expect(result.error).toMatch(/ya accepted/i);
  });

  it("cross-tenant: userA cannot accept userB's proposal", async () => {
    const userBId = await seedUser(`${TAG}-userB@test.local`);
    const accountBId = await seedAccount(userBId);
    const recurringBId = await seedRecurring(userBId, accountBId, BigInt(-42000));

    const proposalBId = await seedProposal(userBId, recurringBId, "amount_update", {
      newAmountCents: "-44900",
      oldAmountCents: "-42000",
      currency: "COP",
      observationCount: 2,
    });

    // Session is userA — trying to accept userB's proposal.
    const result = await acceptProposal({ proposalId: proposalBId });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should not reach");
    expect(result.error).toMatch(/no encontrada/i);

    // Cleanup userB
    await db.execute(sql`DELETE FROM recurring_proposals WHERE id = ${proposalBId}`);
    await db.execute(sql`DELETE FROM recurring_transactions WHERE id = ${recurringBId}`);
    await db.execute(sql`DELETE FROM accounts WHERE id = ${accountBId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userBId}`);
  });
});

describe("acceptProposal (variable_flag)", () => {
  let userAId: number;
  let accountAId: number;
  let recurringAId: number;

  beforeEach(async () => {
    await cleanup();
    userAId = await seedUser(`${TAG}-userA@test.local`);
    accountAId = await seedAccount(userAId);
    recurringAId = await seedRecurring(userAId, accountAId, BigInt(-42000));
    mockGetSessionUser.mockResolvedValue({
      id: userAId,
      email: `${TAG}-userA@test.local`,
      name: "A",
      role: "user" as const,
      active: true,
    });
  });

  afterEach(cleanup);

  it("sets amount_type='variable' on the recurring", async () => {
    const proposalId = await seedProposal(userAId, recurringAId, "variable_flag", {
      detectedAmounts: ["-42000", "-55000", "-31000"],
      currency: "COP",
      observationCount: 3,
    });

    const result = await acceptProposal({ proposalId });

    expect(result.ok).toBe(true);

    const [rt] = await db
      .select({ amountType: recurringTransactions.amountType })
      .from(recurringTransactions)
      .where(eq(recurringTransactions.id, recurringAId));

    expect(rt?.amountType).toBe("variable");
  });
});

describe("rejectProposal", () => {
  let userAId: number;
  let accountAId: number;
  let recurringAId: number;

  beforeEach(async () => {
    await cleanup();
    userAId = await seedUser(`${TAG}-userA@test.local`);
    accountAId = await seedAccount(userAId);
    recurringAId = await seedRecurring(userAId, accountAId, BigInt(-42000));
    mockGetSessionUser.mockResolvedValue({
      id: userAId,
      email: `${TAG}-userA@test.local`,
      name: "A",
      role: "user" as const,
      active: true,
    });
  });

  afterEach(cleanup);

  it("marks proposal rejected without changing the recurring", async () => {
    const proposalId = await seedProposal(userAId, recurringAId, "amount_update", {
      newAmountCents: "-44900",
      oldAmountCents: "-42000",
      currency: "COP",
      observationCount: 2,
    });

    const result = await rejectProposal({ proposalId });

    expect(result.ok).toBe(true);

    const [p] = await db
      .select({ status: recurringProposals.status })
      .from(recurringProposals)
      .where(eq(recurringProposals.id, proposalId));

    expect(p?.status).toBe("rejected");

    // Recurring amount unchanged.
    const [rt] = await db
      .select({ amountCents: recurringTransactions.amountCents })
      .from(recurringTransactions)
      .where(eq(recurringTransactions.id, recurringAId));

    expect(rt?.amountCents.toString()).toBe("-42000");
  });

  it("cross-tenant: userA cannot reject userB's proposal", async () => {
    const userBId = await seedUser(`${TAG}-userB@test.local`);
    const accountBId = await seedAccount(userBId);
    const recurringBId = await seedRecurring(userBId, accountBId, BigInt(-42000));

    const proposalBId = await seedProposal(userBId, recurringBId, "amount_update", {});

    const result = await rejectProposal({ proposalId: proposalBId });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should not reach");
    expect(result.error).toMatch(/no encontrada/i);

    await db.execute(sql`DELETE FROM recurring_proposals WHERE id = ${proposalBId}`);
    await db.execute(sql`DELETE FROM recurring_transactions WHERE id = ${recurringBId}`);
    await db.execute(sql`DELETE FROM accounts WHERE id = ${accountBId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userBId}`);
  });
});

describe("countPendingProposals", () => {
  let userAId: number;
  let accountAId: number;
  let recurringAId: number;

  beforeEach(async () => {
    await cleanup();
    userAId = await seedUser(`${TAG}-userA@test.local`);
    accountAId = await seedAccount(userAId);
    recurringAId = await seedRecurring(userAId, accountAId, BigInt(-42000));
    // Point the session mock at the freshly-seeded user.
    mockGetSessionUser.mockResolvedValue({
      id: userAId,
      email: `${TAG}-userA@test.local`,
      name: "UserA",
      role: "user" as const,
      active: true,
    });
  });

  afterEach(cleanup);

  it("returns 0 when no pending proposals", async () => {
    const count = await countPendingProposals();
    expect(count).toBe(0);
  });

  it("returns correct count of pending proposals", async () => {
    await seedProposal(userAId, recurringAId, "amount_update", {});
    const count = await countPendingProposals();
    expect(count).toBe(1);
  });

  it("does not count non-pending proposals", async () => {
    const proposalId = await seedProposal(userAId, recurringAId, "amount_update", {});
    await db
      .update(recurringProposals)
      .set({ status: "accepted" })
      .where(eq(recurringProposals.id, proposalId));

    const count = await countPendingProposals();
    expect(count).toBe(0);
  });
});
