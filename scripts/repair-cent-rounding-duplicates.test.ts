import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import {
  accounts,
  reconciliationDecisions,
  recurringTransactions,
  statementImports,
  transactions,
  users,
} from "../src/lib/db/schema";
import { notDeleted } from "../src/lib/db/helpers";
import { copyCategorySeedsToUser } from "../src/lib/auth/signup";
import {
  repairCentRoundingDuplicates,
  type CentRoundingPair,
} from "./repair-cent-rounding-duplicates";

// #1023 — integration tests for the one-shot repair of the 7 prod pairs a
// cent-rounding near-match left duplicated. The script's identifiers are fixed
// prod ids, so every test injects its own pairs against fixtures it owns.

const TAG = "ROUNDING_REPAIR_TEST";
const DAY_MS = 86_400_000;
const OCURRED_AT = new Date("2026-10-26T05:00:00Z");

const createdUserIds: number[] = [];

async function createUser(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email: `${TAG.toLowerCase()}.${randomUUID()}@test.local`, name: TAG })
    .returning({ id: users.id });
  // `category_slug` is FK-checked per user (transactions_user_category_fk), so
  // the survivor's `pago-tc` category has to exist for this user.
  await copyCategorySeedsToUser(row.id);
  createdUserIds.push(row.id);
  return row.id;
}

async function createAccount(userId: number, currency: "COP" | "USD" = "COP"): Promise<number> {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG} ${currency}`,
      institution: "Bancolombia",
      institutionSlug: "bancolombia",
      type: "savings",
      currency,
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function createStatementImport(userId: number, accountId: number): Promise<number> {
  const [row] = await db
    .insert(statementImports)
    .values({
      userId,
      accountId,
      fileHash: `${TAG}-${randomUUID()}`,
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
    })
    .returning({ id: statementImports.id });
  return row.id;
}

type SeedTxn = {
  userId: number;
  accountId: number;
  amountCents: bigint;
  descriptionRaw: string;
  occurredAt?: Date;
  reconciliationStatus?: "unreconciled" | "matched" | "flagged" | "imported_from_statement";
  statementImportId?: number | null;
  transferGroupId?: string | null;
  recurringId?: number | null;
  categorySlug?: string | null;
};

async function seedTxn(seed: SeedTxn): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      userId: seed.userId,
      accountId: seed.accountId,
      occurredAt: seed.occurredAt ?? OCURRED_AT,
      amountCents: seed.amountCents,
      currency: "COP",
      descriptionRaw: seed.descriptionRaw,
      categorySlug: seed.categorySlug ?? null,
      source: "sms",
      channel: "bank",
      reconciliationStatus: seed.reconciliationStatus ?? "unreconciled",
      statementImportId: seed.statementImportId ?? null,
      transferGroupId: seed.transferGroupId ?? null,
      recurringId: seed.recurringId ?? null,
    })
    .returning({ id: transactions.id });
  return row.id;
}

/**
 * The prod shape: an SMS-captured row rounded to the peso, flagged because the
 * statement row matched nothing, plus the statement row itself — same account,
 * 70 cents apart, same day.
 */
async function seedPair(
  userId: number,
  accountId: number,
  overrides: { statementGroupId?: string | null; flaggedGroupId?: string | null } = {},
): Promise<{ pair: CentRoundingPair; flaggedTxnId: number; statementTxnId: number }> {
  const statementImportId = await createStatementImport(userId, accountId);
  const flaggedTxnId = await seedTxn({
    userId,
    accountId,
    amountCents: BigInt(-1_459_00),
    descriptionRaw: "Pago TC *7291",
    reconciliationStatus: "flagged",
    categorySlug: "pago-tc",
    transferGroupId: overrides.flaggedGroupId ?? null,
  });
  const statementTxnId = await seedTxn({
    userId,
    accountId,
    amountCents: BigInt(-1_459_70),
    descriptionRaw: "PAGO TC *7291 BANCOLOMBIA",
    reconciliationStatus: "imported_from_statement",
    statementImportId,
    transferGroupId: overrides.statementGroupId ?? null,
  });
  return { pair: { flaggedTxnId, statementTxnId }, flaggedTxnId, statementTxnId };
}

async function readTxn(id: number) {
  const [row] = await db.select().from(transactions).where(eq(transactions.id, id));
  return row;
}

async function decisionsFor(txnIds: number[]) {
  return db
    .select()
    .from(reconciliationDecisions)
    .where(inArray(reconciliationDecisions.txnId, txnIds));
}

// Raw SQL on purpose: every one of these tables carries `deleted_at`, and
// eslint's no-restricted-syntax rule rightly refuses `db.delete()` on them
// outside `src/**/*.test.ts`. Fixture teardown is the one legitimate hard
// delete, and it is scoped to the tagged users this file created.
async function cleanupUser(userId: number): Promise<void> {
  await db.execute(sql`
    DELETE FROM reconciliation_decisions
    WHERE txn_id IN (SELECT id FROM transactions WHERE user_id = ${userId})`);
  await db.execute(sql`DELETE FROM transactions WHERE user_id = ${userId}`);
  await db.execute(sql`DELETE FROM recurring_transactions WHERE user_id = ${userId}`);
  await db.execute(sql`DELETE FROM statement_imports WHERE user_id = ${userId}`);
  await db.execute(sql`DELETE FROM accounts WHERE user_id = ${userId}`);
  await db.execute(sql`DELETE FROM physical_cards WHERE user_id = ${userId}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
}

afterAll(async () => {
  for (const userId of createdUserIds) await cleanupUser(userId);
});

describe("repairCentRoundingDuplicates (#1023)", () => {
  it("dry run lists every pair with its action and writes nothing", async () => {
    const userId = await createUser();
    const accountId = await createAccount(userId);
    const a = await seedPair(userId, accountId);
    const b = await seedPair(userId, accountId);
    const pairs = [a.pair, b.pair];

    const before = await readTxn(a.flaggedTxnId);
    const report = await repairCentRoundingDuplicates({ dryRun: true, userId, pairs });

    expect(report.dryRun).toBe(true);
    expect(report.pairs).toHaveLength(2);
    expect(report.pairs[0]).toMatchObject({
      flaggedTxnId: a.flaggedTxnId,
      statementTxnId: a.statementTxnId,
      accountId,
      action: "merge_into_statement",
      amountDiffCents: "-70",
      dateDiffDays: 0,
      transferGroupId: null,
      adoptsTransferGroup: false,
      groupOtherLegs: [],
      groupSumBefore: null,
    });

    // Nothing moved: statuses untouched, no audit rows, nothing soft-deleted.
    expect(await readTxn(a.flaggedTxnId)).toEqual(before);
    expect((await readTxn(a.statementTxnId)).deletedAt).toBeNull();
    expect(await decisionsFor([a.flaggedTxnId, b.flaggedTxnId])).toEqual([]);
  });

  it("merges the statement's authoritative fields onto the surviving row and retires it", async () => {
    const userId = await createUser();
    const accountId = await createAccount(userId);
    const { pair, flaggedTxnId, statementTxnId } = await seedPair(userId, accountId);
    const statementBefore = await readTxn(statementTxnId);

    const liveBefore = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), notDeleted(transactions.deletedAt)));

    const report = await repairCentRoundingDuplicates({ dryRun: false, userId, pairs: [pair] });
    expect(report.pairs).toHaveLength(1);

    const survivor = await readTxn(flaggedTxnId);
    expect(survivor.reconciliationStatus).toBe("matched");
    expect(survivor.reconciledAt).not.toBeNull();
    expect(survivor.amountCents).toBe(statementBefore.amountCents);
    expect(survivor.descriptionRaw).toBe(statementBefore.descriptionRaw);
    expect(survivor.statementImportId).toBe(statementBefore.statementImportId);
    // The reason the survivor is the survivor: it keeps what was classified.
    expect(survivor.categorySlug).toBe("pago-tc");

    // The statement row is retired, not hard-deleted: the audit trail survives.
    const retired = await readTxn(statementTxnId);
    expect(retired.deletedAt).not.toBeNull();

    const decisions = await decisionsFor([flaggedTxnId]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      txnId: flaggedTxnId,
      action: "merged_into",
      mergedIntoTxnId: statementTxnId,
    });

    // No row was inserted: the live count only ever shrinks by the retired row.
    const liveAfter = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), notDeleted(transactions.deletedAt)));
    expect(liveAfter).toHaveLength(liveBefore.length - 1);
    expect(liveAfter.map((r) => r.id)).toContain(flaggedTxnId);
  });

  it("moves group membership onto the surviving leg without touching the other leg", async () => {
    const userId = await createUser();
    const accountId = await createAccount(userId);
    const groupId = randomUUID();
    // Only the statement leg carries the group; its sibling is the TC credit
    // captured at the rounded figure.
    const { pair, flaggedTxnId } = await seedPair(userId, accountId, { statementGroupId: groupId });
    const siblingId = await seedTxn({
      userId,
      accountId: await createAccount(userId, "USD"),
      amountCents: BigInt(1_459_00),
      descriptionRaw: "PAGO TC *7291",
      reconciliationStatus: "matched",
      transferGroupId: groupId,
    });

    const report = await repairCentRoundingDuplicates({ dryRun: false, userId, pairs: [pair] });
    // Σ before = statement (−1459,70) + sibling (+1459,00) = −70; the survivor
    // takes the statement's amount, so the group's sum must come out identical
    // — and the sibling must not be rewritten to fake a zero.
    expect(report.pairs[0]).toMatchObject({
      transferGroupId: groupId,
      adoptsTransferGroup: true,
      groupOtherLegs: [{ txnId: siblingId, amountCents: "145900" }],
      groupSumBefore: "-70",
    });

    const survivor = await readTxn(flaggedTxnId);
    expect(survivor.transferGroupId).toBe(groupId);

    const legs = await db
      .select({ id: transactions.id, amountCents: transactions.amountCents })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.transferGroupId, groupId),
          notDeleted(transactions.deletedAt),
        ),
      );
    expect(legs.map((l) => l.id).sort()).toEqual([flaggedTxnId, siblingId].sort());
    expect(legs.reduce((acc, l) => acc + l.amountCents, BigInt(0))).toBe(BigInt(-70));
    expect(legs.find((l) => l.id === siblingId)?.amountCents).toBe(BigInt(1_459_00));
  });

  // The prod shape, verified against the snapshot: the flagged savings leg is
  // the one inside the Pago TC group, the COP twin is already soft-deleted, and
  // the live counterpart is a USD leg — so the group genuinely does not sum to
  // zero and the repair has no business "balancing" it.
  it("leaves the survivor's own cross-currency group untouched apart from the survivor", async () => {
    const userId = await createUser();
    const accountId = await createAccount(userId);
    const groupId = randomUUID();
    const { pair, flaggedTxnId } = await seedPair(userId, accountId, { flaggedGroupId: groupId });
    const usdAccountId = await createAccount(userId, "USD");
    const siblingId = await seedTxn({
      userId,
      accountId: usdAccountId,
      amountCents: BigInt(10_800),
      descriptionRaw: "ABONO SUCURSAL VIRTUAL",
      reconciliationStatus: "imported_from_statement",
      transferGroupId: groupId,
    });
    // The COP twin the routing already retired: still in the group's history,
    // never counted by a live-leg read.
    await db
      .update(transactions)
      .set({ deletedAt: new Date() })
      .where(
        eq(
          transactions.id,
          await seedTxn({
            userId,
            accountId,
            amountCents: BigInt(1_459_00),
            descriptionRaw: "Pago TC *7291",
            reconciliationStatus: "unreconciled",
            transferGroupId: groupId,
          }),
        ),
      );

    const report = await repairCentRoundingDuplicates({ dryRun: false, userId, pairs: [pair] });
    expect(report.pairs[0]).toMatchObject({
      transferGroupId: groupId,
      adoptsTransferGroup: false,
      groupOtherLegs: [{ txnId: siblingId, amountCents: "10800" }],
    });

    const survivor = await readTxn(flaggedTxnId);
    expect(survivor.transferGroupId).toBe(groupId);
    expect(survivor.amountCents).toBe(BigInt(-1_459_70));
    const legs = await db
      .select({ id: transactions.id, amountCents: transactions.amountCents })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.transferGroupId, groupId),
          notDeleted(transactions.deletedAt),
        ),
      );
    expect(legs.map((l) => l.id).sort()).toEqual([flaggedTxnId, siblingId].sort());
    // The USD leg keeps its own amount: the repair never fabricates a balancing
    // figure for a group it does not own.
    expect(legs.find((l) => l.id === siblingId)?.amountCents).toBe(BigInt(10_800));
  });

  it("carries a recurring link the surviving row does not have", async () => {
    const userId = await createUser();
    const accountId = await createAccount(userId);
    const [recurring] = await db
      .insert(recurringTransactions)
      .values({
        userId,
        accountId,
        label: `${TAG} recurrente`,
        amountCents: BigInt(1_459_00),
        currency: "COP",
        dayOfMonth: 26,
      })
      .returning({ id: recurringTransactions.id });

    const statementImportId = await createStatementImport(userId, accountId);
    const flaggedTxnId = await seedTxn({
      userId,
      accountId,
      amountCents: BigInt(-1_459_00),
      descriptionRaw: "Pago TC *7291",
      reconciliationStatus: "flagged",
    });
    const statementTxnId = await seedTxn({
      userId,
      accountId,
      amountCents: BigInt(-1_459_70),
      descriptionRaw: "PAGO TC *7291 BANCOLOMBIA",
      reconciliationStatus: "imported_from_statement",
      statementImportId,
      recurringId: recurring.id,
    });

    const report = await repairCentRoundingDuplicates({
      dryRun: false,
      userId,
      pairs: [{ flaggedTxnId, statementTxnId }],
    });
    expect(report.pairs[0].carriedRecurringId).toBe(recurring.id);
    expect((await readTxn(flaggedTxnId)).recurringId).toBe(recurring.id);
  });

  it("aborts before writing when a pair is not in the expected state", async () => {
    const userId = await createUser();
    const accountId = await createAccount(userId);
    const bad = await seedPair(userId, accountId);
    const good = await seedPair(userId, accountId);
    // Already reconciled by hand: not ours to touch.
    await db
      .update(transactions)
      .set({ reconciliationStatus: "matched" })
      .where(eq(transactions.id, bad.flaggedTxnId));

    await expect(
      repairCentRoundingDuplicates({ dryRun: false, userId, pairs: [bad.pair, good.pair] }),
    ).rejects.toThrow(/rounding_repair_flagged_status/);

    // The valid pair that came after it was not applied either: planning
    // completes for every pair before the first write.
    const untouched = await readTxn(good.flaggedTxnId);
    expect(untouched.reconciliationStatus).toBe("flagged");
    expect((await readTxn(good.statementTxnId)).deletedAt).toBeNull();
    expect(await decisionsFor([bad.flaggedTxnId, good.flaggedTxnId])).toEqual([]);
  });

  it("aborts on a pair outside the rounding window or outside the date window", async () => {
    const userId = await createUser();
    const accountId = await createAccount(userId);
    const statementImportId = await createStatementImport(userId, accountId);
    const window = async (amountDelta: bigint, daysApart: number) => ({
      flaggedTxnId: await seedTxn({
        userId,
        accountId,
        amountCents: BigInt(-1_459_00),
        descriptionRaw: "Pago TC *7291",
        reconciliationStatus: "flagged",
      }),
      statementTxnId: await seedTxn({
        userId,
        accountId,
        amountCents: BigInt(-1_459_00) - amountDelta,
        occurredAt: new Date(OCURRED_AT.getTime() + daysApart * DAY_MS),
        descriptionRaw: "PAGO TC *7291 BANCOLOMBIA",
        reconciliationStatus: "imported_from_statement",
        statementImportId,
      }),
    });

    await expect(
      repairCentRoundingDuplicates({ dryRun: true, userId, pairs: [await window(BigInt(500), 0)] }),
    ).rejects.toThrow(/rounding_repair_amount_out_of_window/);

    await expect(
      repairCentRoundingDuplicates({ dryRun: true, userId, pairs: [await window(BigInt(70), 3)] }),
    ).rejects.toThrow(/rounding_repair_date_out_of_window/);
  });

  it("aborts when both legs already claim a transfer group", async () => {
    const userId = await createUser();
    const accountId = await createAccount(userId);
    const { pair } = await seedPair(userId, accountId, {
      statementGroupId: randomUUID(),
      flaggedGroupId: randomUUID(),
    });

    await expect(
      repairCentRoundingDuplicates({ dryRun: true, userId, pairs: [pair] }),
    ).rejects.toThrow(/rounding_repair_shared_transfer_group/);

    // Same group on both legs is the same stop: the pair IS the group, and
    // which leg survives is not a decision this script may make.
    const sameGroupId = randomUUID();
    const shared = await seedPair(userId, accountId, {
      statementGroupId: sameGroupId,
      flaggedGroupId: sameGroupId,
    });
    await expect(
      repairCentRoundingDuplicates({ dryRun: true, userId, pairs: [shared.pair] }),
    ).rejects.toThrow(/rounding_repair_shared_transfer_group/);
  });
});
