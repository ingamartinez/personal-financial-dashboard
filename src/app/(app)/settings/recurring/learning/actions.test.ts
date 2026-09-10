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
  proposalType: "amount_update" | "variable_flag" | "amount_outlier",
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

  // #870: cross-currency + no-op guards.

  it("rejects a proposal whose payload currency no longer matches the recurring's currency", async () => {
    // recurringAId is COP (seeded default). Proposal was computed while it
    // was USD and never should be accepted as-is.
    const proposalId = await seedProposal(userAId, recurringAId, "amount_update", {
      newAmountCents: "-2000",
      oldAmountCents: "-20000",
      currency: "USD",
      observationCount: 2,
    });

    const result = await acceptProposal({ proposalId });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should not reach");
    expect(result.error).toMatch(/USD.*COP|moneda/i);

    // Recurring untouched.
    const [rt] = await db
      .select({ amountCents: recurringTransactions.amountCents })
      .from(recurringTransactions)
      .where(eq(recurringTransactions.id, recurringAId));
    expect(rt?.amountCents.toString()).toBe("-42000");

    // Proposal stays pending — never silently marked accepted/rejected.
    const [p] = await db
      .select({ status: recurringProposals.status })
      .from(recurringProposals)
      .where(eq(recurringProposals.id, proposalId));
    expect(p?.status).toBe("pending");
  });

  it("accepts a no-op proposal (newAmountCents already equals the recurring's estimate) without rewriting", async () => {
    const proposalId = await seedProposal(userAId, recurringAId, "amount_update", {
      newAmountCents: "-42000",
      oldAmountCents: "-42000",
      currency: "COP",
      observationCount: 2,
    });

    const result = await acceptProposal({ proposalId });

    expect(result.ok).toBe(true);

    // Amount unchanged (was already -42000).
    const [rt] = await db
      .select({ amountCents: recurringTransactions.amountCents })
      .from(recurringTransactions)
      .where(eq(recurringTransactions.id, recurringAId));
    expect(rt?.amountCents.toString()).toBe("-42000");

    // Proposal marked decided (accepted), not left pending.
    const [p] = await db
      .select({ status: recurringProposals.status })
      .from(recurringProposals)
      .where(eq(recurringProposals.id, proposalId));
    expect(p?.status).toBe("accepted");
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

describe("acceptProposal (amount_outlier)", () => {
  let userAId: number;
  let accountAId: number;
  let recurringAId: number;

  beforeEach(async () => {
    await cleanup();
    userAId = await seedUser(`${TAG}-userA@test.local`);
    accountAId = await seedAccount(userAId);
    recurringAId = await seedRecurring(userAId, accountAId, BigInt(-42_000));
    await db
      .update(recurringTransactions)
      .set({ amountType: "variable" })
      .where(eq(recurringTransactions.id, recurringAId));
    mockGetSessionUser.mockResolvedValue({
      id: userAId,
      email: `${TAG}-userA@test.local`,
      name: "A",
      role: "user" as const,
      active: true,
    });
  });

  afterEach(cleanup);

  async function seedOutlierObs(): Promise<{ outlierObsId: number }> {
    const amounts = [BigInt(-50_000), BigInt(-60_000), BigInt(-55_000), BigInt(-200_000)];
    const months = ["2026-01", "2026-02", "2026-03", "2026-04"] as const;
    const dates = [
      new Date("2026-01-15T12:00:00Z"),
      new Date("2026-02-15T12:00:00Z"),
      new Date("2026-03-15T12:00:00Z"),
      new Date("2026-04-15T12:00:00Z"),
    ];
    let outlierObsId = 0;
    for (let i = 0; i < amounts.length; i++) {
      const txId = await seedTx(userAId, accountAId);
      const [row] = await db
        .insert(recurringLinkObservations)
        .values({
          userId: userAId,
          recurringId: recurringAId,
          txId,
          yearMonth: months[i],
          realAmountCents: amounts[i]!,
          realCurrency: "COP",
          descriptionRaw: `${TAG}-tx`,
          accountId: accountAId,
          manual: true,
          applied: false,
          observedAt: dates[i],
        })
        .returning({ id: recurringLinkObservations.id });
      if (i === amounts.length - 1) outlierObsId = row.id;
    }
    return { outlierObsId };
  }

  it("new_normal keeps the outlier in the band and recomputes the median", async () => {
    const { outlierObsId } = await seedOutlierObs();
    const proposalId = await seedProposal(userAId, recurringAId, "amount_outlier", {
      observationId: outlierObsId,
      outlierAmountCents: "-200000",
      bandLoAbsCents: "50000",
      bandHiAbsCents: "60000",
      currency: "COP",
      observationCount: 4,
    });

    const result = await acceptProposal({ proposalId, outlierDecision: "new_normal" });
    expect(result.ok).toBe(true);

    const [obs] = await db
      .select({ excludedAt: recurringLinkObservations.excludedAt })
      .from(recurringLinkObservations)
      .where(eq(recurringLinkObservations.id, outlierObsId));
    expect(obs?.excludedAt).toBeNull();

    const [rt] = await db
      .select({ amountCents: recurringTransactions.amountCents })
      .from(recurringTransactions)
      .where(eq(recurringTransactions.id, recurringAId));
    // last 3: -200k, -55k, -60k → median -60k
    expect(rt?.amountCents).toBe(BigInt(-60_000));

    const [p] = await db
      .select({ status: recurringProposals.status })
      .from(recurringProposals)
      .where(eq(recurringProposals.id, proposalId));
    expect(p?.status).toBe("accepted");
  });

  it("one_off sets excluded_at and drops the outlier from the median", async () => {
    const { outlierObsId } = await seedOutlierObs();
    const proposalId = await seedProposal(userAId, recurringAId, "amount_outlier", {
      observationId: outlierObsId,
      outlierAmountCents: "-200000",
      bandLoAbsCents: "50000",
      bandHiAbsCents: "60000",
      currency: "COP",
      observationCount: 4,
    });

    const result = await acceptProposal({ proposalId, outlierDecision: "one_off" });
    expect(result.ok).toBe(true);

    const [obs] = await db
      .select({ excludedAt: recurringLinkObservations.excludedAt })
      .from(recurringLinkObservations)
      .where(eq(recurringLinkObservations.id, outlierObsId));
    expect(obs?.excludedAt).not.toBeNull();

    const [rt] = await db
      .select({ amountCents: recurringTransactions.amountCents })
      .from(recurringTransactions)
      .where(eq(recurringTransactions.id, recurringAId));
    // remaining last 3: -55k, -60k, -50k → median -55k
    expect(rt?.amountCents).toBe(BigInt(-55_000));
  });

  it("rejects amount_outlier without an outlierDecision", async () => {
    const { outlierObsId } = await seedOutlierObs();
    const proposalId = await seedProposal(userAId, recurringAId, "amount_outlier", {
      observationId: outlierObsId,
      outlierAmountCents: "-200000",
      bandLoAbsCents: "50000",
      bandHiAbsCents: "60000",
      currency: "COP",
      observationCount: 4,
    });

    const result = await acceptProposal({ proposalId });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("should not reach");
    expect(result.error).toMatch(/decisión|nuevo normal|puntual/i);

    const [p] = await db
      .select({ status: recurringProposals.status })
      .from(recurringProposals)
      .where(eq(recurringProposals.id, proposalId));
    expect(p?.status).toBe("pending");
  });

  it("cross-tenant: userA cannot accept userB's amount_outlier as new_normal or one_off", async () => {
    const userBId = await seedUser(`${TAG}-userB@test.local`);
    const accountBId = await seedAccount(userBId);
    const recurringBId = await seedRecurring(userBId, accountBId, BigInt(-42_000));
    await db
      .update(recurringTransactions)
      .set({ amountType: "variable", amountCents: BigInt(-42_000) })
      .where(eq(recurringTransactions.id, recurringBId));

    const txId = await seedTx(userBId, accountBId);
    const [obsB] = await db
      .insert(recurringLinkObservations)
      .values({
        userId: userBId,
        recurringId: recurringBId,
        txId,
        yearMonth: "2026-04",
        realAmountCents: BigInt(-200_000),
        realCurrency: "COP",
        descriptionRaw: `${TAG}-tx`,
        accountId: accountBId,
        manual: true,
        applied: false,
      })
      .returning({ id: recurringLinkObservations.id });

    const proposalBId = await seedProposal(userBId, recurringBId, "amount_outlier", {
      observationId: obsB.id,
      outlierAmountCents: "-200000",
      bandLoAbsCents: "-50000",
      bandHiAbsCents: "-60000",
      currency: "COP",
      observationCount: 4,
    });

    const newNormal = await acceptProposal({
      proposalId: proposalBId,
      outlierDecision: "new_normal",
    });
    expect(newNormal.ok).toBe(false);
    if (newNormal.ok) throw new Error("should not reach");
    expect(newNormal.error).toMatch(/no encontrada/i);

    const oneOff = await acceptProposal({
      proposalId: proposalBId,
      outlierDecision: "one_off",
    });
    expect(oneOff.ok).toBe(false);
    if (oneOff.ok) throw new Error("should not reach");
    expect(oneOff.error).toMatch(/no encontrada/i);

    const [p] = await db
      .select({ status: recurringProposals.status })
      .from(recurringProposals)
      .where(eq(recurringProposals.id, proposalBId));
    expect(p?.status).toBe("pending");

    const [rt] = await db
      .select({ amountCents: recurringTransactions.amountCents })
      .from(recurringTransactions)
      .where(eq(recurringTransactions.id, recurringBId));
    expect(rt?.amountCents).toBe(BigInt(-42_000));

    const [obs] = await db
      .select({ excludedAt: recurringLinkObservations.excludedAt })
      .from(recurringLinkObservations)
      .where(eq(recurringLinkObservations.id, obsB.id));
    expect(obs?.excludedAt).toBeNull();

    await db.execute(sql`DELETE FROM recurring_link_observations WHERE id = ${obsB.id}`);
    await db.execute(sql`DELETE FROM recurring_proposals WHERE id = ${proposalBId}`);
    await db.execute(sql`DELETE FROM transactions WHERE id = ${txId}`);
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
