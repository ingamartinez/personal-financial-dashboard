import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  ingestionLogs,
  statementImports,
  transactions,
  userHealthSnapshots,
} from "@/lib/db/schema";
import {
  computeUserHealthSnapshot,
  saveUserHealthSnapshot,
  snapshotAllActiveUsers,
} from "./user-health";

const TEST_USER_ID = 1;
const TEST_ACCOUNT = "__uht_test_account__";
const TEST_TX_TAG = "__uht_test_tx__";

async function cleanup() {
  await db.execute(sql`DELETE FROM user_health_snapshots WHERE user_id = ${TEST_USER_ID}`);
  await db.execute(sql`DELETE FROM transactions WHERE description_raw LIKE '__uht_test_tx__%'`);
  // Wipe all ingestion_logs for the test user — the test DB doesn't seed any
  // baseline logs, so this is safe and avoids cross-test pollution.
  await db.execute(sql`DELETE FROM ingestion_logs WHERE user_id = ${TEST_USER_ID}`);
  await db.execute(sql`DELETE FROM statement_imports WHERE user_id = ${TEST_USER_ID}`);
  await db.execute(sql`DELETE FROM accounts WHERE name = ${TEST_ACCOUNT}`);
}

async function seedAccount(): Promise<number> {
  const [a] = await db
    .insert(accounts)
    .values({
      userId: TEST_USER_ID,
      name: TEST_ACCOUNT,
      institution: "Test",
      type: "savings",
      currency: "COP",
    })
    .returning({ id: accounts.id });
  return a.id;
}

async function seedTx(opts: {
  accountId: number;
  source: "sms" | "apple_pay" | "telegram" | "manual" | "csv";
  createdAt: Date;
  channel?: "bank" | "manual" | "transfer";
  isAdjustment?: boolean;
  amountCents?: bigint;
  reconciliationStatus?: "unreconciled" | "matched" | "flagged" | "imported_from_statement";
}): Promise<void> {
  await db.insert(transactions).values({
    userId: TEST_USER_ID,
    accountId: opts.accountId,
    occurredAt: opts.createdAt,
    amountCents: opts.amountCents ?? BigInt(-10000),
    currency: "COP",
    descriptionRaw: `${TEST_TX_TAG}-${opts.source}`,
    source: opts.source,
    channel: opts.channel ?? "bank",
    isAdjustment: opts.isAdjustment ?? false,
    reconciliationStatus: opts.reconciliationStatus ?? "unreconciled",
    createdAt: opts.createdAt,
    updatedAt: opts.createdAt,
  });
}

async function seedLog(opts: {
  source: "sms" | "csv" | "ocr" | "manual" | "telegram" | "apple_pay";
  status: "inserted" | "duplicated" | "error" | "skipped" | "debug";
  startedAt: Date;
  kind?: string;
}): Promise<void> {
  await db.insert(ingestionLogs).values({
    userId: TEST_USER_ID,
    source: opts.source,
    status: opts.status,
    itemsReceived: 1,
    itemsInserted: opts.status === "inserted" ? 1 : 0,
    itemsDuplicated: opts.status === "duplicated" ? 1 : 0,
    payload: { kind: opts.kind ?? "uht-test" },
    startedAt: opts.startedAt,
    finishedAt: opts.startedAt,
  });
}

const NOW = new Date(Date.UTC(2026, 3, 20, 12, 0, 0));
const ago = (days: number, hours = 0) =>
  new Date(NOW.getTime() - days * 86_400_000 - hours * 3_600_000);

describe("computeUserHealthSnapshot", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns zeros/nulls when the user has no activity", async () => {
    const snap = await computeUserHealthSnapshot(TEST_USER_ID, NOW);
    expect(snap.lastSmsReceivedAt).toBeNull();
    expect(snap.lastCaptureAt).toBeNull();
    expect(snap.captureSources30d).toEqual({});
    expect(snap.parserSuccessRate30d).toBeNull();
    expect(snap.unreconciledTxnCount).toBe(0);
    expect(snap.divergenceCents).toBeNull();
    expect(snap.statementDivergenceCents).toBeNull();
    expect(snap.churnSignalFlag).toBe(false);
  });

  it("groups capture_sources_30d by transactions.source within the window", async () => {
    const accountId = await seedAccount();
    await seedTx({ accountId, source: "sms", createdAt: ago(1) });
    await seedTx({ accountId, source: "sms", createdAt: ago(5) });
    await seedTx({ accountId, source: "telegram", createdAt: ago(10) });
    await seedTx({ accountId, source: "manual", createdAt: ago(15) });
    // Outside the 30-day window → excluded.
    await seedTx({ accountId, source: "csv", createdAt: ago(40) });

    const snap = await computeUserHealthSnapshot(TEST_USER_ID, NOW);
    expect(snap.captureSources30d).toEqual({ sms: 2, telegram: 1, manual: 1 });
  });

  it("uses ingestion_logs (source='sms') for last_sms_received_at, not transactions", async () => {
    const accountId = await seedAccount();
    // A telegram txn is more recent than the SMS log — but lastSmsReceivedAt
    // should still point at the SMS log.
    await seedTx({ accountId, source: "telegram", createdAt: ago(0, 1) });
    const smsLogAt = ago(2);
    await seedLog({ source: "sms", status: "inserted", startedAt: smsLogAt });

    const snap = await computeUserHealthSnapshot(TEST_USER_ID, NOW);
    expect(snap.lastSmsReceivedAt?.toISOString()).toBe(smsLogAt.toISOString());
  });

  it("computes parser_success_rate_30d across all sources, excluding AI-classify and debug", async () => {
    await seedLog({ source: "sms", status: "inserted", startedAt: ago(1) });
    await seedLog({ source: "sms", status: "duplicated", startedAt: ago(2) });
    await seedLog({ source: "csv", status: "inserted", startedAt: ago(3) });
    await seedLog({ source: "telegram", status: "error", startedAt: ago(4) });
    await seedLog({ source: "sms", status: "skipped", startedAt: ago(5) });
    // Must NOT count:
    await seedLog({ source: "manual", status: "inserted", startedAt: ago(6), kind: "ai-classify" });
    await seedLog({
      source: "apple_pay",
      status: "debug",
      startedAt: ago(7),
      kind: "debug-capture",
    });
    // Outside window.
    await seedLog({ source: "sms", status: "error", startedAt: ago(40) });

    const snap = await computeUserHealthSnapshot(TEST_USER_ID, NOW);
    // 3 success (2 sms-inserted/duplicated + 1 csv-inserted) / 5 total → 0.6
    expect(snap.parserSuccessRate30d).toBeCloseTo(0.6, 5);
  });

  it("returns parser_success_rate_30d=null when there are no ingest attempts in 30d", async () => {
    await seedLog({ source: "sms", status: "inserted", startedAt: ago(40) });
    const snap = await computeUserHealthSnapshot(TEST_USER_ID, NOW);
    expect(snap.parserSuccessRate30d).toBeNull();
  });

  it("flags churn when last_capture > 7d and first_capture > 14d", async () => {
    const accountId = await seedAccount();
    await seedTx({ accountId, source: "sms", createdAt: ago(20) });
    await seedTx({ accountId, source: "sms", createdAt: ago(8) });

    const snap = await computeUserHealthSnapshot(TEST_USER_ID, NOW);
    expect(snap.churnSignalFlag).toBe(true);
  });

  it("does not flag churn when the user is too new (first_capture within 14d)", async () => {
    const accountId = await seedAccount();
    // First capture 10d ago — user is "new". Last capture 8d ago — stale, but
    // we should not call them churned yet.
    await seedTx({ accountId, source: "sms", createdAt: ago(10) });
    await seedTx({ accountId, source: "sms", createdAt: ago(8) });

    const snap = await computeUserHealthSnapshot(TEST_USER_ID, NOW);
    expect(snap.churnSignalFlag).toBe(false);
  });

  it("does not flag churn when the last capture is within 7d", async () => {
    const accountId = await seedAccount();
    await seedTx({ accountId, source: "sms", createdAt: ago(20) });
    await seedTx({ accountId, source: "sms", createdAt: ago(1) });

    const snap = await computeUserHealthSnapshot(TEST_USER_ID, NOW);
    expect(snap.churnSignalFlag).toBe(false);
  });

  it("counts only unreconciled bank-channel non-adjustment txns as unreconciled", async () => {
    const accountId = await seedAccount();
    // 2 unreconciled bank rows → should be counted
    await seedTx({
      accountId,
      source: "sms",
      createdAt: ago(1),
      reconciliationStatus: "unreconciled",
    });
    await seedTx({
      accountId,
      source: "sms",
      createdAt: ago(2),
      reconciliationStatus: "unreconciled",
    });
    // matched → excluded
    await seedTx({
      accountId,
      source: "sms",
      createdAt: ago(3),
      reconciliationStatus: "matched",
    });
    // manual channel → excluded even when unreconciled
    await seedTx({
      accountId,
      source: "manual",
      createdAt: ago(4),
      channel: "manual",
      reconciliationStatus: "unreconciled",
    });
    // is_adjustment → excluded
    await seedTx({
      accountId,
      source: "manual",
      createdAt: ago(5),
      isAdjustment: true,
      reconciliationStatus: "unreconciled",
    });

    const snap = await computeUserHealthSnapshot(TEST_USER_ID, NOW);
    expect(snap.unreconciledTxnCount).toBe(2);
  });

  it("sums is_adjustment txn amounts in the last 30 days for divergenceCents (signed)", async () => {
    const accountId = await seedAccount();
    // +50000 adjustment (findash was UNDER)
    await seedTx({
      accountId,
      source: "manual",
      createdAt: ago(1),
      isAdjustment: true,
      amountCents: BigInt(50_000_00),
    });
    // −10000 adjustment (findash was slightly OVER)
    await seedTx({
      accountId,
      source: "manual",
      createdAt: ago(5),
      isAdjustment: true,
      amountCents: BigInt(-10_000_00),
    });
    // outside the window → excluded
    await seedTx({
      accountId,
      source: "manual",
      createdAt: ago(40),
      isAdjustment: true,
      amountCents: BigInt(999_999_00),
    });

    const snap = await computeUserHealthSnapshot(TEST_USER_ID, NOW);
    expect(snap.divergenceCents).toBe(BigInt(40_000_00));
  });

  it("returns divergenceCents=null when there are zero adjustments in the window", async () => {
    const accountId = await seedAccount();
    await seedTx({ accountId, source: "sms", createdAt: ago(1) });

    const snap = await computeUserHealthSnapshot(TEST_USER_ID, NOW);
    expect(snap.divergenceCents).toBeNull();
  });

  it("statementDivergenceCents sums (findash − latest statement) per account in the 30d window", async () => {
    const accountId = await seedAccount();
    // Set findash's account balance.
    await db
      .update(accounts)
      .set({ balanceCents: BigInt(1_200_000_00) })
      .where(sql`${accounts.id} = ${accountId}`);

    // Two imports for the same account — the later one should win.
    const periodEndRecent = new Date(NOW.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
    const periodEndOlder = new Date(NOW.getTime() - 15 * 86_400_000).toISOString().slice(0, 10);
    await db.insert(statementImports).values({
      userId: TEST_USER_ID,
      accountId,
      fileHash: "a".repeat(64),
      periodStart: periodEndOlder,
      periodEnd: periodEndOlder,
      txnCount: 0,
      balanceAtEndCents: BigInt(999_999_99),
    });
    await db.insert(statementImports).values({
      userId: TEST_USER_ID,
      accountId,
      fileHash: "b".repeat(64),
      periodStart: periodEndRecent,
      periodEnd: periodEndRecent,
      txnCount: 0,
      balanceAtEndCents: BigInt(1_000_000_00),
    });

    const snap = await computeUserHealthSnapshot(TEST_USER_ID, NOW);
    // findash 1_200_000.00 − latest stmt 1_000_000.00 = +200_000.00 (findash overstates)
    expect(snap.statementDivergenceCents).toBe(BigInt(200_000_00));
  });

  it("statementDivergenceCents ignores imports older than 30 days", async () => {
    const accountId = await seedAccount();
    await db
      .update(accounts)
      .set({ balanceCents: BigInt(500_000_00) })
      .where(sql`${accounts.id} = ${accountId}`);

    const stale = new Date(NOW.getTime() - 40 * 86_400_000).toISOString().slice(0, 10);
    await db.insert(statementImports).values({
      userId: TEST_USER_ID,
      accountId,
      fileHash: "c".repeat(64),
      periodStart: stale,
      periodEnd: stale,
      txnCount: 0,
      balanceAtEndCents: BigInt(999_999_99),
    });

    const snap = await computeUserHealthSnapshot(TEST_USER_ID, NOW);
    expect(snap.statementDivergenceCents).toBeNull();
  });

  it("statementDivergenceCents ignores imports whose balance_at_end is NULL", async () => {
    const accountId = await seedAccount();
    await db
      .update(accounts)
      .set({ balanceCents: BigInt(100_000_00) })
      .where(sql`${accounts.id} = ${accountId}`);

    const recent = new Date(NOW.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
    await db.insert(statementImports).values({
      userId: TEST_USER_ID,
      accountId,
      fileHash: "d".repeat(64),
      periodStart: recent,
      periodEnd: recent,
      txnCount: 0,
      balanceAtEndCents: null,
    });

    const snap = await computeUserHealthSnapshot(TEST_USER_ID, NOW);
    expect(snap.statementDivergenceCents).toBeNull();
  });
});

describe("saveUserHealthSnapshot + snapshotAllActiveUsers", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("persists a computed snapshot with the correct shape", async () => {
    const accountId = await seedAccount();
    await seedTx({ accountId, source: "sms", createdAt: ago(1) });
    await seedLog({ source: "sms", status: "inserted", startedAt: ago(1) });

    const data = await computeUserHealthSnapshot(TEST_USER_ID, NOW);
    await saveUserHealthSnapshot(TEST_USER_ID, data, NOW);

    const [row] = await db
      .select()
      .from(userHealthSnapshots)
      .where(sql`${userHealthSnapshots.userId} = ${TEST_USER_ID}`);
    expect(row.capturedAt.toISOString()).toBe(NOW.toISOString());
    expect(row.captureSources30d).toEqual({ sms: 1 });
    expect(row.parserSuccessRate30d).toBe("1.0000");
    // The seeded txn defaults to bank channel + unreconciled status, so it counts.
    expect(row.unreconciledTxnCount).toBe(1);
    expect(row.divergenceCents).toBeNull();
    expect(row.statementDivergenceCents).toBeNull();
    expect(row.churnSignalFlag).toBe(false);
  });

  it("snapshotAllActiveUsers fans out across active users and returns per-user results", async () => {
    const results = await snapshotAllActiveUsers(NOW);
    // At least the bootstrap test user (id=1) should be included and succeed.
    const testEntry = results.find((r) => r.userId === TEST_USER_ID);
    expect(testEntry).toBeDefined();
    expect(testEntry?.ok).toBe(true);
  });
});
