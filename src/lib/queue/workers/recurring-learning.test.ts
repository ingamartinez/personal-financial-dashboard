// #633: Integration tests for the recurring-learning BullMQ worker processor.
// Runs against findash_test (forced by vitest.setup.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Job } from "bullmq";
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

vi.mock("@/lib/queue", () => ({
  createWorker: vi.fn().mockReturnValue({
    on: vi.fn(),
    close: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Lazy import (after mocks)
// ---------------------------------------------------------------------------

const { recurringLearningProcessor } = await import("./recurring-learning");

// ---------------------------------------------------------------------------
// Test data tag and seed helpers
// ---------------------------------------------------------------------------

const TAG = "test-rlearning-633";

function mockJob(): Job {
  return { id: "test-job-id" } as unknown as Job;
}

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

async function seedTx(
  userId: number,
  accountId: number,
  amountCents: bigint = BigInt(-42000),
): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      accountId,
      occurredAt: new Date("2026-04-15T12:00:00Z"),
      amountCents,
      currency: "COP",
      descriptionRaw: `${TAG}-tx`,
      classificationMethod: "unclassified",
      source: "manual",
    })
    .returning({ id: transactions.id });
  return row.id;
}

async function cleanup() {
  await db.execute(
    sql`DELETE FROM recurring_proposals WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})`,
  );
  await db.execute(
    sql`DELETE FROM recurring_link_observations WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})`,
  );
  await db.execute(sql`DELETE FROM transactions WHERE description_raw = ${TAG + "-tx"}`);
  await db.execute(sql`DELETE FROM recurring_transactions WHERE label = ${TAG + "-recurring"}`);
  await db.execute(sql`DELETE FROM accounts WHERE name = ${TAG + "-acct"}`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${TAG + "%"}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("recurringLearningProcessor", () => {
  let userAId: number;
  let accountAId: number;
  let recurringAId: number;

  beforeEach(async () => {
    await cleanup();
    userAId = await seedUser(`${TAG}-userA@test.local`);
    accountAId = await seedAccount(userAId);
    recurringAId = await seedRecurring(userAId, accountAId, BigInt(-42000));
  });

  afterEach(cleanup);

  it("N=2 same-amount-delta > 5% triggers amount_update proposal", async () => {
    // Real amount = -44900, estimated = -42000 → drift ≈ 6.9% > 5%
    const tx1 = await seedTx(userAId, accountAId, BigInt(-44900));
    const tx2 = await seedTx(userAId, accountAId, BigInt(-44900));

    // Insert observations directly.
    await db.insert(recurringLinkObservations).values([
      {
        userId: userAId,
        recurringId: recurringAId,
        txId: tx1,
        yearMonth: "2026-03",
        realAmountCents: BigInt(-44900),
        realCurrency: "COP",
        descriptionRaw: `${TAG}-tx`,
        accountId: accountAId,
        manual: true,
        applied: false,
      },
      {
        userId: userAId,
        recurringId: recurringAId,
        txId: tx2,
        yearMonth: "2026-04",
        realAmountCents: BigInt(-44900),
        realCurrency: "COP",
        descriptionRaw: `${TAG}-tx`,
        accountId: accountAId,
        manual: true,
        applied: false,
      },
    ]);

    const result = await recurringLearningProcessor(mockJob());

    expect(result.proposalsCreated).toBe(1);
    expect(result.errors).toBe(0);

    const [proposal] = await db
      .select()
      .from(recurringProposals)
      .where(
        and(
          eq(recurringProposals.userId, userAId),
          eq(recurringProposals.recurringId, recurringAId),
        ),
      );

    expect(proposal?.proposalType).toBe("amount_update");
    expect(proposal?.status).toBe("pending");

    const p = proposal?.payload as { newAmountCents: string };
    expect(p.newAmountCents).toBe("-44900");
  });

  it("N=2 same-amount-delta <= 5% does NOT trigger proposal", async () => {
    // Real amount = -43000, estimated = -42000 → drift ≈ 2.4% < 5%
    const tx1 = await seedTx(userAId, accountAId, BigInt(-43000));
    const tx2 = await seedTx(userAId, accountAId, BigInt(-43000));

    await db.insert(recurringLinkObservations).values([
      {
        userId: userAId,
        recurringId: recurringAId,
        txId: tx1,
        yearMonth: "2026-03",
        realAmountCents: BigInt(-43000),
        realCurrency: "COP",
        descriptionRaw: `${TAG}-tx`,
        accountId: accountAId,
        manual: true,
        applied: false,
      },
      {
        userId: userAId,
        recurringId: recurringAId,
        txId: tx2,
        yearMonth: "2026-04",
        realAmountCents: BigInt(-43000),
        realCurrency: "COP",
        descriptionRaw: `${TAG}-tx`,
        accountId: accountAId,
        manual: true,
        applied: false,
      },
    ]);

    const result = await recurringLearningProcessor(mockJob());

    expect(result.proposalsCreated).toBe(0);

    const proposals = await db
      .select()
      .from(recurringProposals)
      .where(eq(recurringProposals.userId, userAId));

    expect(proposals).toHaveLength(0);
  });

  it("N=3 non-uniform amounts triggers variable_flag proposal", async () => {
    const tx1 = await seedTx(userAId, accountAId, BigInt(-42000));
    const tx2 = await seedTx(userAId, accountAId, BigInt(-55000));
    const tx3 = await seedTx(userAId, accountAId, BigInt(-31000));

    await db.insert(recurringLinkObservations).values([
      {
        userId: userAId,
        recurringId: recurringAId,
        txId: tx1,
        yearMonth: "2026-02",
        realAmountCents: BigInt(-42000),
        realCurrency: "COP",
        descriptionRaw: `${TAG}-tx`,
        accountId: accountAId,
        manual: true,
        applied: false,
      },
      {
        userId: userAId,
        recurringId: recurringAId,
        txId: tx2,
        yearMonth: "2026-03",
        realAmountCents: BigInt(-55000),
        realCurrency: "COP",
        descriptionRaw: `${TAG}-tx`,
        accountId: accountAId,
        manual: true,
        applied: false,
      },
      {
        userId: userAId,
        recurringId: recurringAId,
        txId: tx3,
        yearMonth: "2026-04",
        realAmountCents: BigInt(-31000),
        realCurrency: "COP",
        descriptionRaw: `${TAG}-tx`,
        accountId: accountAId,
        manual: true,
        applied: false,
      },
    ]);

    const result = await recurringLearningProcessor(mockJob());

    expect(result.proposalsCreated).toBe(1);

    const [proposal] = await db
      .select()
      .from(recurringProposals)
      .where(eq(recurringProposals.userId, userAId));

    expect(proposal?.proposalType).toBe("variable_flag");
    expect(proposal?.status).toBe("pending");
  });

  it("skips a recurring that already has a pending proposal", async () => {
    // Seed 2 qualifying observations.
    const tx1 = await seedTx(userAId, accountAId, BigInt(-44900));
    const tx2 = await seedTx(userAId, accountAId, BigInt(-44900));

    await db.insert(recurringLinkObservations).values([
      {
        userId: userAId,
        recurringId: recurringAId,
        txId: tx1,
        yearMonth: "2026-03",
        realAmountCents: BigInt(-44900),
        realCurrency: "COP",
        descriptionRaw: `${TAG}-tx`,
        accountId: accountAId,
        manual: true,
        applied: false,
      },
      {
        userId: userAId,
        recurringId: recurringAId,
        txId: tx2,
        yearMonth: "2026-04",
        realAmountCents: BigInt(-44900),
        realCurrency: "COP",
        descriptionRaw: `${TAG}-tx`,
        accountId: accountAId,
        manual: true,
        applied: false,
      },
    ]);

    // Pre-existing pending proposal.
    await db.insert(recurringProposals).values({
      userId: userAId,
      recurringId: recurringAId,
      proposalType: "amount_update",
      payload: { existing: true },
      status: "pending",
    });

    const result = await recurringLearningProcessor(mockJob());

    // Should not create a second proposal.
    expect(result.proposalsCreated).toBe(0);

    const proposals = await db
      .select()
      .from(recurringProposals)
      .where(eq(recurringProposals.userId, userAId));

    expect(proposals).toHaveLength(1);
  });

  it("tenant isolation: userA observations do not trigger userB proposals", async () => {
    const userBId = await seedUser(`${TAG}-userB@test.local`);
    const accountBId = await seedAccount(userBId);
    const recurringBId = await seedRecurring(userBId, accountBId, BigInt(-42000));

    // UserA has 2 qualifying observations.
    const txA1 = await seedTx(userAId, accountAId, BigInt(-44900));
    const txA2 = await seedTx(userAId, accountAId, BigInt(-44900));

    await db.insert(recurringLinkObservations).values([
      {
        userId: userAId,
        recurringId: recurringAId,
        txId: txA1,
        yearMonth: "2026-03",
        realAmountCents: BigInt(-44900),
        realCurrency: "COP",
        descriptionRaw: `${TAG}-tx`,
        accountId: accountAId,
        manual: true,
        applied: false,
      },
      {
        userId: userAId,
        recurringId: recurringAId,
        txId: txA2,
        yearMonth: "2026-04",
        realAmountCents: BigInt(-44900),
        realCurrency: "COP",
        descriptionRaw: `${TAG}-tx`,
        accountId: accountAId,
        manual: true,
        applied: false,
      },
    ]);

    // UserB has no observations.

    const result = await recurringLearningProcessor(mockJob());

    // Proposal should only be for userA, not for userB.
    const proposalsB = await db
      .select()
      .from(recurringProposals)
      .where(eq(recurringProposals.userId, userBId));

    expect(proposalsB).toHaveLength(0);
    expect(result.usersProcessed).toBe(1);

    // Cleanup userB
    await db.execute(sql`DELETE FROM recurring_transactions WHERE id = ${recurringBId}`);
    await db.execute(sql`DELETE FROM accounts WHERE id = ${accountBId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userBId}`);
  });
});
