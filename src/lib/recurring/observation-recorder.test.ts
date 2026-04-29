// #633: Integration tests for the observation recorder.
// Runs against findash_test (forced by vitest.setup.ts).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  recurringDescriptionPatterns,
  recurringLinkObservations,
  recurringTransactions,
  transactions,
  users,
} from "@/lib/db/schema";
import { copyCategorySeedsToUser, copyRuleSeedsToUser } from "@/lib/auth/signup";
import { recordRecurringLinkObservation, tokeniseDescription } from "./observation-recorder";

// ---------------------------------------------------------------------------
// Test data tag and seed helpers
// ---------------------------------------------------------------------------

const TAG = "test-obs-recorder-633";

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

async function seedRecurring(userId: number, accountId: number): Promise<number> {
  const [row] = await db
    .insert(recurringTransactions)
    .values({
      userId,
      accountId,
      label: `${TAG}-recurring`,
      amountCents: BigInt(-44900),
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
  descriptionRaw = `${TAG}-tx`,
  amountCents: bigint = BigInt(-44900),
): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      accountId,
      occurredAt: new Date("2026-04-15T12:00:00Z"),
      amountCents,
      currency: "COP",
      descriptionRaw,
      classificationMethod: "unclassified",
      source: "manual",
    })
    .returning({ id: transactions.id });
  return row.id;
}

async function cleanup() {
  // Remove in FK order — all keyed by the tagged user emails.
  await db.execute(sql`
    DELETE FROM recurring_link_observations
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})
  `);
  await db.execute(sql`
    DELETE FROM recurring_description_patterns
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})
  `);
  await db.execute(sql`
    DELETE FROM transactions
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})
  `);
  await db.execute(sql`
    DELETE FROM recurring_transactions
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})
  `);
  await db.execute(sql`
    DELETE FROM accounts
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${TAG + "%"})
  `);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${TAG + "%"}`);
}

// ---------------------------------------------------------------------------
// tokeniseDescription unit tests (pure, no DB)
// ---------------------------------------------------------------------------

describe("tokeniseDescription", () => {
  it("extracts the first significant alphabetic token", () => {
    expect(tokeniseDescription("NETFLIX*DL")).toBe("NETFLIX");
    expect(tokeniseDescription("SPOTIFY P 12345")).toBe("SPOTIFY");
    expect(tokeniseDescription("GOOGLE *PLAY YOUTUBE")).toBe("GOOGLE");
  });

  it("returns null for purely numeric or short strings", () => {
    expect(tokeniseDescription("1234 5678")).toBeNull();
    expect(tokeniseDescription("AB")).toBeNull();
    expect(tokeniseDescription("")).toBeNull();
    expect(tokeniseDescription(null)).toBeNull();
    expect(tokeniseDescription(undefined)).toBeNull();
  });

  it("is case-insensitive (uppercases before tokenising)", () => {
    expect(tokeniseDescription("netflix*dl")).toBe("NETFLIX");
  });

  it("strips non-alphanumeric characters before splitting", () => {
    expect(tokeniseDescription("PAYU-WOMPI-12345")).toBe("PAYU");
  });
});

// ---------------------------------------------------------------------------
// recordRecurringLinkObservation integration tests
// ---------------------------------------------------------------------------

describe("recordRecurringLinkObservation", () => {
  let userAId: number;
  let accountAId: number;
  let recurringAId: number;

  beforeEach(async () => {
    await cleanup();
    userAId = await seedUser(`${TAG}-userA@test.local`);
    accountAId = await seedAccount(userAId);
    recurringAId = await seedRecurring(userAId, accountAId);
  });

  afterEach(cleanup);

  it("inserts an observation with correct fields", async () => {
    const txId = await seedTx(userAId, accountAId, "NETFLIX*DL");
    await recordRecurringLinkObservation({
      userId: userAId,
      recurringId: recurringAId,
      txId,
      yearMonth: "2026-04",
      manual: true,
    });

    const [obs] = await db
      .select()
      .from(recurringLinkObservations)
      .where(
        and(
          eq(recurringLinkObservations.txId, txId),
          eq(recurringLinkObservations.userId, userAId),
        ),
      );

    expect(obs).toBeDefined();
    expect(obs?.recurringId).toBe(recurringAId);
    expect(obs?.yearMonth).toBe("2026-04");
    expect(obs?.manual).toBe(true);
    expect(obs?.applied).toBe(false);
    expect(obs?.realAmountCents.toString()).toBe("-44900");
    expect(obs?.realCurrency).toBe("COP");
    expect(obs?.descriptionRaw).toBe("NETFLIX*DL");
  });

  it("is idempotent — second call on same (userId, recurringId, txId, yearMonth) is a no-op", async () => {
    const txId = await seedTx(userAId, accountAId);
    await recordRecurringLinkObservation({
      userId: userAId,
      recurringId: recurringAId,
      txId,
      yearMonth: "2026-04",
      manual: true,
    });
    // Second call — must not throw or insert a duplicate.
    await expect(
      recordRecurringLinkObservation({
        userId: userAId,
        recurringId: recurringAId,
        txId,
        yearMonth: "2026-04",
        manual: true,
      }),
    ).resolves.toBeUndefined();

    const rows = await db
      .select({ id: recurringLinkObservations.id })
      .from(recurringLinkObservations)
      .where(
        and(
          eq(recurringLinkObservations.userId, userAId),
          eq(recurringLinkObservations.recurringId, recurringAId),
          eq(recurringLinkObservations.txId, txId),
        ),
      );

    expect(rows).toHaveLength(1);
  });

  it("upserts a description pattern and increments observation_count", async () => {
    const txId1 = await seedTx(userAId, accountAId, "NETFLIX*DL");
    await recordRecurringLinkObservation({
      userId: userAId,
      recurringId: recurringAId,
      txId: txId1,
      yearMonth: "2026-03",
      manual: true,
    });

    const txId2 = await seedTx(userAId, accountAId, "NETFLIX*HD");
    await recordRecurringLinkObservation({
      userId: userAId,
      recurringId: recurringAId,
      txId: txId2,
      yearMonth: "2026-04",
      manual: true,
    });

    // Both descriptions tokenise to "NETFLIX" — count should be 2.
    const [pattern] = await db
      .select({ observationCount: recurringDescriptionPatterns.observationCount })
      .from(recurringDescriptionPatterns)
      .where(
        and(
          eq(recurringDescriptionPatterns.userId, userAId),
          eq(recurringDescriptionPatterns.recurringId, recurringAId),
          eq(recurringDescriptionPatterns.pattern, "NETFLIX"),
        ),
      );

    expect(pattern?.observationCount).toBe(2);
  });

  it("marks pattern_ambiguous when two different recurrings share the same token (Google Play caveat)", async () => {
    const recurringBId = await seedRecurring(userAId, accountAId);

    const txId1 = await seedTx(userAId, accountAId, "GOOGLE *PLAY YOUTUBE");
    await recordRecurringLinkObservation({
      userId: userAId,
      recurringId: recurringAId,
      txId: txId1,
      yearMonth: "2026-04",
      manual: true,
    });

    const txId2 = await seedTx(userAId, accountAId, "GOOGLE *PLAY SPOTIFY");
    await recordRecurringLinkObservation({
      userId: userAId,
      recurringId: recurringBId,
      txId: txId2,
      yearMonth: "2026-04",
      manual: true,
    });

    // Both patterns tokenise to "GOOGLE" — both should now be marked ambiguous.
    const patterns = await db
      .select({ patternAmbiguous: recurringDescriptionPatterns.patternAmbiguous })
      .from(recurringDescriptionPatterns)
      .where(
        and(
          eq(recurringDescriptionPatterns.userId, userAId),
          eq(recurringDescriptionPatterns.pattern, "GOOGLE"),
        ),
      );

    expect(patterns).toHaveLength(2);
    expect(patterns.every((p) => p.patternAmbiguous)).toBe(true);
  });

  it("does nothing (no error) when tx not found", async () => {
    // txId = 999999999 (non-existent)
    await expect(
      recordRecurringLinkObservation({
        userId: userAId,
        recurringId: recurringAId,
        txId: 999999999,
        yearMonth: "2026-04",
        manual: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("tenant-safe: userA observation does not leak into userB", async () => {
    const userBId = await seedUser(`${TAG}-userB@test.local`);
    const accountBId = await seedAccount(userBId);
    const recurringBId = await seedRecurring(userBId, accountBId);

    // Tx belongs to userA; we try to record an observation for userB's recurring.
    const txId = await seedTx(userAId, accountAId);

    // The recorder fetches the tx with userId filter — userB cannot record
    // an observation for userA's tx.
    await recordRecurringLinkObservation({
      userId: userBId, // trying to record as userB
      recurringId: recurringBId,
      txId, // but tx belongs to userA
      yearMonth: "2026-04",
      manual: true,
    });

    // No observation should have been created (tx not found for userB).
    const rows = await db
      .select()
      .from(recurringLinkObservations)
      .where(eq(recurringLinkObservations.txId, txId));

    expect(rows).toHaveLength(0);
  });
});
