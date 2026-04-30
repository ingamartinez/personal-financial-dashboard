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

// emitNotification is mocked to avoid hitting the notifications table and the
// SSE bus during integration tests. We spy on it to assert emit calls.
const emitMocks = vi.hoisted(() => ({ emitNotification: vi.fn() }));
vi.mock("@/lib/notifications/emit", () => ({
  emitNotification: emitMocks.emitNotification,
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
  return {
    id: "test-job-id",
    updateProgress: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job;
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
    emitMocks.emitNotification.mockReset();
    emitMocks.emitNotification.mockResolvedValue({ id: 1 });
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

  it("expiry sweep: proposals older than 30 days are set to expired; fresh ones stay pending", async () => {
    // Seed a 31-day-old pending proposal (stale).
    const [staleRow] = await db
      .insert(recurringProposals)
      .values({
        userId: userAId,
        recurringId: recurringAId,
        proposalType: "amount_update",
        payload: { stale: true },
        status: "pending",
        createdAt: new Date(Date.now() - 31 * 86400000),
      })
      .returning({ id: recurringProposals.id });

    // Seed a second recurring so the fresh proposal doesn't conflict.
    const recurringBId = await seedRecurring(userAId, accountAId, BigInt(-42000));

    // Seed a fresh pending proposal (1 day old).
    const [freshRow] = await db
      .insert(recurringProposals)
      .values({
        userId: userAId,
        recurringId: recurringBId,
        proposalType: "amount_update",
        payload: { fresh: true },
        status: "pending",
        createdAt: new Date(Date.now() - 86400000),
      })
      .returning({ id: recurringProposals.id });

    await recurringLearningProcessor(mockJob());

    const [stale] = await db
      .select({ status: recurringProposals.status })
      .from(recurringProposals)
      .where(eq(recurringProposals.id, staleRow.id));

    const [fresh] = await db
      .select({ status: recurringProposals.status })
      .from(recurringProposals)
      .where(eq(recurringProposals.id, freshRow.id));

    expect(stale?.status).toBe("expired");
    expect(fresh?.status).toBe("pending");

    // Cleanup extra recurring.
    await db.execute(sql`DELETE FROM recurring_transactions WHERE id = ${recurringBId}`);
  });

  it("calls updateProgress at start and done — Bull-Board contract", async () => {
    // No observations — empty run still exercises start + done progress calls.
    const job = mockJob();
    const result = await recurringLearningProcessor(job);

    expect(result.usersProcessed).toBe(0);
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ users: 0 }));
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ done: true }));
    expect(job.log).toHaveBeenCalled();
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

  // ── New: notification emitter tests ─────────────────────────────────────

  it("emits recurring_proposal_ready when an amount_update proposal is created", async () => {
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

    await recurringLearningProcessor(mockJob());

    expect(emitMocks.emitNotification).toHaveBeenCalledOnce();

    const [calledUserId, calledInput] = emitMocks.emitNotification.mock.calls[0] as [
      number,
      {
        type: string;
        entityId: string;
        metadata: { proposalKind: string; recurringId: number; proposalId: number };
      },
    ];

    expect(calledUserId).toBe(userAId);
    expect(calledInput.type).toBe("recurring_proposal_ready");
    expect(calledInput.metadata.proposalKind).toBe("amount_update");
    expect(calledInput.metadata.recurringId).toBe(recurringAId);
    // entityId must be the stringified proposalId (never null).
    expect(calledInput.entityId).toBe(String(calledInput.metadata.proposalId));
    expect(calledInput.metadata.proposalId).toBeGreaterThan(0);
  });

  it("emits recurring_proposal_ready when a variable_flag proposal is created", async () => {
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

    await recurringLearningProcessor(mockJob());

    expect(emitMocks.emitNotification).toHaveBeenCalledOnce();

    const [, calledInput] = emitMocks.emitNotification.mock.calls[0] as [
      number,
      { metadata: { proposalKind: string } },
    ];
    expect(calledInput.metadata.proposalKind).toBe("variable_flag");
  });

  it("does NOT emit when existing pending proposal causes skip (idempotent guard)", async () => {
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

    // Pre-existing pending proposal — the processor should skip and NOT emit.
    await db.insert(recurringProposals).values({
      userId: userAId,
      recurringId: recurringAId,
      proposalType: "amount_update",
      payload: { existing: true },
      status: "pending",
    });

    await recurringLearningProcessor(mockJob());

    expect(emitMocks.emitNotification).not.toHaveBeenCalled();
  });

  it("emits one notification per user in a multi-user run", async () => {
    const userBId = await seedUser(`${TAG}-userB@test.local`);
    const accountBId = await seedAccount(userBId);
    const recurringBId = await seedRecurring(userBId, accountBId, BigInt(-42000));

    // UserA: 2 qualifying observations.
    const txA1 = await seedTx(userAId, accountAId, BigInt(-44900));
    const txA2 = await seedTx(userAId, accountAId, BigInt(-44900));

    // UserB: 2 qualifying observations (different amount, same drift).
    const txB1 = await seedTx(userBId, accountBId, BigInt(-50000));
    const txB2 = await seedTx(userBId, accountBId, BigInt(-50000));

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
      {
        userId: userBId,
        recurringId: recurringBId,
        txId: txB1,
        yearMonth: "2026-03",
        realAmountCents: BigInt(-50000),
        realCurrency: "COP",
        descriptionRaw: `${TAG}-tx`,
        accountId: accountBId,
        manual: true,
        applied: false,
      },
      {
        userId: userBId,
        recurringId: recurringBId,
        txId: txB2,
        yearMonth: "2026-04",
        realAmountCents: BigInt(-50000),
        realCurrency: "COP",
        descriptionRaw: `${TAG}-tx`,
        accountId: accountBId,
        manual: true,
        applied: false,
      },
    ]);

    await recurringLearningProcessor(mockJob());

    // One emit per user.
    expect(emitMocks.emitNotification).toHaveBeenCalledTimes(2);

    const calledUserIds = emitMocks.emitNotification.mock.calls.map(
      (args: unknown[]) => args[0] as number,
    );
    expect(calledUserIds).toContain(userAId);
    expect(calledUserIds).toContain(userBId);

    // Cleanup userB
    await db.execute(sql`DELETE FROM recurring_proposals WHERE user_id = ${userBId}`);
    await db.execute(sql`DELETE FROM recurring_link_observations WHERE user_id = ${userBId}`);
    await db.execute(
      sql`DELETE FROM transactions WHERE description_raw = ${TAG + "-tx"} AND user_id = ${userBId}`,
    );
    await db.execute(sql`DELETE FROM recurring_transactions WHERE id = ${recurringBId}`);
    await db.execute(sql`DELETE FROM accounts WHERE id = ${accountBId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userBId}`);
  });

  it("does NOT emit when no proposals are created (observations below threshold)", async () => {
    // Only 1 observation — below MIN_OBSERVATIONS_FOR_AMOUNT_UPDATE (2).
    const tx1 = await seedTx(userAId, accountAId, BigInt(-44900));

    await db.insert(recurringLinkObservations).values({
      userId: userAId,
      recurringId: recurringAId,
      txId: tx1,
      yearMonth: "2026-04",
      realAmountCents: BigInt(-44900),
      realCurrency: "COP",
      descriptionRaw: `${TAG}-tx`,
      accountId: accountAId,
      manual: true,
      applied: false,
    });

    await recurringLearningProcessor(mockJob());

    expect(emitMocks.emitNotification).not.toHaveBeenCalled();
  });
});
