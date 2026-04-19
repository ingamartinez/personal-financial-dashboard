import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, ingestionLogs, transactions, userHealthSnapshots } from "@/lib/db/schema";
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
}): Promise<void> {
  await db.insert(transactions).values({
    userId: TEST_USER_ID,
    accountId: opts.accountId,
    occurredAt: opts.createdAt,
    amountCents: BigInt(-10000),
    currency: "COP",
    descriptionRaw: `${TEST_TX_TAG}-${opts.source}`,
    source: opts.source,
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
    expect(row.unreconciledTxnCount).toBe(0);
    expect(row.divergenceCents).toBeNull();
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
