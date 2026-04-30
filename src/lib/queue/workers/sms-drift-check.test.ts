import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ingestionLogs, users } from "@/lib/db/schema";
import { smsDriftCheckProcessor } from "./sms-drift-check";

// ---------------------------------------------------------------------------
// emitNotification mock — hoisted so factories run before module-level code
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  emitNotification: vi.fn().mockResolvedValue({ id: 999 }),
}));

vi.mock("@/lib/notifications/emit", () => ({
  emitNotification: mocks.emitNotification,
}));

// ---------------------------------------------------------------------------
// Minimal Job stub — only the methods the processor calls
// ---------------------------------------------------------------------------
function makeJob(): Job<Record<string, never>> {
  return {
    id: "test-job-id",
    updateProgress: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job<Record<string, never>>;
}

// ---------------------------------------------------------------------------
// User setup — only user 1 is seeded in findash_test by default.
// For multi-user tests we create an ephemeral user and clean it up after.
// ---------------------------------------------------------------------------

const USER_A = 1; // permanent seeded user

let ephemeralUserBId: number | null = null;

async function createEphemeralUserB(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email: "sms-drift-test-b@example.com", name: "SMS Drift Test B" })
    .returning({ id: users.id });
  ephemeralUserBId = row.id;
  return row.id;
}

async function deleteEphemeralUserB() {
  if (ephemeralUserBId !== null) {
    await db.execute(sql`DELETE FROM users WHERE id = ${ephemeralUserBId}`);
    ephemeralUserBId = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a Date that falls within the given Bogota day offset.
 * daysOffset=0 → today in COT, daysOffset=-1 → yesterday, etc.
 */
function bogotaDay(daysOffset: number, hour = 12): Date {
  const nowUtc = new Date();
  const todayBogotaStr = nowUtc.toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
  const d = new Date(`${todayBogotaStr}T${String(hour).padStart(2, "0")}:00:00-05:00`);
  d.setDate(d.getDate() + daysOffset);
  return d;
}

async function insertLog(userId: number, daysOffset: number, itemsReceived: number) {
  await db.insert(ingestionLogs).values({
    userId,
    source: "sms",
    status: "success",
    itemsReceived,
    itemsInserted: itemsReceived,
    itemsDuplicated: 0,
    startedAt: bogotaDay(daysOffset),
  });
}

async function cleanup(extraUserId?: number | null) {
  const userIds = [USER_A, ...(extraUserId != null ? [extraUserId] : [])];
  for (const uid of userIds) {
    await db.execute(sql`DELETE FROM ingestion_logs WHERE source = 'sms' AND user_id = ${uid}`);
  }
  mocks.emitNotification.mockClear();
  mocks.emitNotification.mockResolvedValue({ id: 999 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("smsDriftCheckProcessor", () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup(ephemeralUserBId));

  it("emits when avg_7d >= 5 and count_today = 0", async () => {
    // 7 days × 8 SMS/day in past week (no SMS today)
    for (let d = -7; d <= -1; d++) {
      await insertLog(USER_A, d, 8);
    }

    await smsDriftCheckProcessor(makeJob());

    expect(mocks.emitNotification).toHaveBeenCalledOnce();
    const [calledUserId, calledInput] = mocks.emitNotification.mock.calls[0]! as [
      number,
      { type: string; priority: string; actionUrl: string; metadata: { avg7d: number } },
    ];
    expect(calledUserId).toBe(USER_A);
    expect(calledInput.type).toBe("sms_drift_detected");
    expect(calledInput.priority).toBe("medium");
    expect(calledInput.actionUrl).toBe("/settings/integrations");
    // avg7d = 56 / 7 = 8.0
    expect(calledInput.metadata.avg7d).toBeCloseTo(8.0);
  });

  it("does NOT emit when avg_7d < 5 (below threshold)", async () => {
    // 7 days × 3 SMS/day → avg_7d = 3, below threshold of 5
    for (let d = -7; d <= -1; d++) {
      await insertLog(USER_A, d, 3);
    }

    await smsDriftCheckProcessor(makeJob());

    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("does NOT emit when count_today > 0", async () => {
    // Past week: avg = 8/day
    for (let d = -7; d <= -1; d++) {
      await insertLog(USER_A, d, 8);
    }
    // Today: 2 SMS received
    await insertLog(USER_A, 0, 2);

    await smsDriftCheckProcessor(makeJob());

    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("does NOT emit when user has 0 SMS in last 7 days (no baseline)", async () => {
    // No rows at all → no baseline, no emit
    await smsDriftCheckProcessor(makeJob());

    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it("tenant safety: emits only for user A when A qualifies but B does not", async () => {
    const userBId = await createEphemeralUserB();

    // User A: avg 8/day last 7, nothing today → qualifies
    for (let d = -7; d <= -1; d++) {
      await insertLog(USER_A, d, 8);
    }
    // User B: avg 3/day last 7, nothing today → below threshold
    for (let d = -7; d <= -1; d++) {
      await insertLog(userBId, d, 3);
    }

    await smsDriftCheckProcessor(makeJob());

    expect(mocks.emitNotification).toHaveBeenCalledOnce();
    expect(mocks.emitNotification.mock.calls[0]![0]).toBe(USER_A);

    await deleteEphemeralUserB();
  });

  it("dedup: second run on the same day does NOT fire a second insert", async () => {
    // Arrange: user qualifies
    for (let d = -7; d <= -1; d++) {
      await insertLog(USER_A, d, 8);
    }

    // First run → emitNotification returns { id: 999 } (inserted)
    mocks.emitNotification.mockResolvedValueOnce({ id: 999 });
    await smsDriftCheckProcessor(makeJob());
    expect(mocks.emitNotification).toHaveBeenCalledOnce();

    // Second run → emitNotification returns null (deduped by the emit layer)
    mocks.emitNotification.mockResolvedValueOnce(null);
    await smsDriftCheckProcessor(makeJob());

    // emitNotification was called twice total (the processor attempted both times,
    // but the emit layer deduped the second)
    expect(mocks.emitNotification).toHaveBeenCalledTimes(2);

    // Both calls used the same entityId (same Bogota date)
    const entityId0 = (mocks.emitNotification.mock.calls[0]![1] as { entityId: string }).entityId;
    const entityId1 = (mocks.emitNotification.mock.calls[1]![1] as { entityId: string }).entityId;
    expect(entityId0).toBe(entityId1);
  });
});
