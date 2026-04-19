import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, ingestionLogs, users } from "@/lib/db/schema";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue({
    id: 1,
    email: "test@test.local",
    name: "Test",
    role: "user",
    active: true,
  }),
}));

const { retryIngestLog, dismissIngestLog } = await import("./actions");

const TEST_USER_ID = 1;
// Real Bancolombia SMS format. last4=9999 is unseeded so the live POST path
// fails with "no account matches" — exactly the orphan scenario the inbox exists for.
const ORPHAN_SMS =
  "Bancolombia: Compraste COP35.450,00 en DLO*DiDi Food CO Pay con tu T.Cred *9999, el 15/04/2026 a las 20:34. Si tienes dudas, encuentranos aqui: 6045109095 o 018000931987. Estamos cerca.";

async function insertErrorLog(body = ORPHAN_SMS) {
  const [row] = await db
    .insert(ingestionLogs)
    .values({
      userId: TEST_USER_ID,
      source: "sms",
      status: "error",
      itemsReceived: 1,
      errorMessage: "no account matches for kind=purchase",
      payload: { sender: "85784", receivedAt: null, body },
    })
    .returning({ id: ingestionLogs.id });
  return row.id;
}

async function getCopSavingsAccountId() {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, TEST_USER_ID),
        eq(accounts.currency, "COP"),
        eq(accounts.type, "credit_card"),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

async function getUsdAccountId() {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, TEST_USER_ID), eq(accounts.currency, "USD")))
    .limit(1);
  return row?.id ?? null;
}

async function cleanupInbox() {
  await db.execute(sql`DELETE FROM transactions WHERE external_id LIKE 'bcol-sms:%'`);
  await db.execute(sql`DELETE FROM ingestion_logs WHERE user_id = ${TEST_USER_ID}`);
}

describe("ingestion inbox actions", () => {
  beforeEach(cleanupInbox);
  afterEach(cleanupInbox);

  it("retry with a valid account inserts the tx and marks log retried_success", async () => {
    const copId = await getCopSavingsAccountId();
    expect(copId).not.toBeNull();
    const logId = await insertErrorLog();

    const result = await retryIngestLog({ logId, accountId: copId! });
    expect(result.status).toBe("ok");

    const [after] = await db.select().from(ingestionLogs).where(eq(ingestionLogs.id, logId));
    expect(after.resolvedAt).not.toBeNull();
    expect(after.resolution).toBe("retried_success");
    expect(after.resolvedTxnId).not.toBeNull();

    // The tx exists in the forced account.
    const tx = await db.execute<{ account_id: number; source: string }>(
      sql`SELECT account_id, source FROM transactions WHERE id = ${after.resolvedTxnId!}`,
    );
    expect(tx).toHaveLength(1);
    expect(tx[0].account_id).toBe(copId);
    expect(tx[0].source).toBe("sms");
  });

  it("retry with a wrong-currency account marks log retried_failed and surfaces the reason", async () => {
    const usdId = await getUsdAccountId();
    expect(usdId).not.toBeNull();
    const logId = await insertErrorLog();

    const result = await retryIngestLog({ logId, accountId: usdId! });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toMatch(/currency mismatch/);
    }

    const [after] = await db.select().from(ingestionLogs).where(eq(ingestionLogs.id, logId));
    expect(after.resolvedAt).not.toBeNull();
    expect(after.resolution).toBe("retried_failed");
    expect(after.resolvedTxnId).toBeNull();
    expect(after.errorMessage).toMatch(/currency mismatch/);
  });

  it("dismiss marks resolution=dismissed without creating a tx", async () => {
    const logId = await insertErrorLog();
    const result = await dismissIngestLog({ logId });
    expect(result.status).toBe("ok");

    const [after] = await db.select().from(ingestionLogs).where(eq(ingestionLogs.id, logId));
    expect(after.resolvedAt).not.toBeNull();
    expect(after.resolution).toBe("dismissed");
    expect(after.resolvedTxnId).toBeNull();
  });

  it("already-resolved log cannot be re-processed (idempotency)", async () => {
    const logId = await insertErrorLog();
    const first = await dismissIngestLog({ logId });
    expect(first.status).toBe("ok");

    // Second dismiss → no-op, surfaces clear message
    const second = await dismissIngestLog({ logId });
    expect(second.status).toBe("error");

    // Retry on a resolved log also refuses
    const copId = await getCopSavingsAccountId();
    const third = await retryIngestLog({ logId, accountId: copId! });
    expect(third.status).toBe("error");

    // Resolution unchanged.
    const [after] = await db.select().from(ingestionLogs).where(eq(ingestionLogs.id, logId));
    expect(after.resolution).toBe("dismissed");
  });
});

describe("ingestion inbox: multi-tenant enforcement", () => {
  const OTHER_USER_EMAIL = "__inbox_other@test.local";
  let otherUserId = 0;
  let otherLogId = 0;

  beforeAll(async () => {
    const [u] = await db
      .insert(users)
      .values({ email: OTHER_USER_EMAIL, name: "Inbox Other" })
      .returning({ id: users.id });
    otherUserId = u.id;
    const [log] = await db
      .insert(ingestionLogs)
      .values({
        userId: otherUserId,
        source: "sms",
        status: "error",
        errorMessage: "no account matches",
        payload: { body: ORPHAN_SMS },
      })
      .returning({ id: ingestionLogs.id });
    otherLogId = log.id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM ingestion_logs WHERE user_id = ${otherUserId}`);
    await db.execute(sql`DELETE FROM users WHERE email = ${OTHER_USER_EMAIL}`);
  });

  it("retry on another user's log refuses", async () => {
    const copId = await getCopSavingsAccountId();
    const result = await retryIngestLog({ logId: otherLogId, accountId: copId! });
    expect(result.status).toBe("error");

    // The other user's log is NOT resolved.
    const [after] = await db.select().from(ingestionLogs).where(eq(ingestionLogs.id, otherLogId));
    expect(after.resolvedAt).toBeNull();
    expect(after.resolution).toBeNull();
  });

  it("dismiss on another user's log refuses", async () => {
    const result = await dismissIngestLog({ logId: otherLogId });
    expect(result.status).toBe("error");

    const [after] = await db.select().from(ingestionLogs).where(eq(ingestionLogs.id, otherLogId));
    expect(after.resolvedAt).toBeNull();
  });
});
