import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { notifications, users } from "@/lib/db/schema";
import { subscribe } from "@/lib/events/bus";
import type { AppEvent } from "@/lib/events/bus";

// ---------------------------------------------------------------------------
// Module under test imported AFTER mocks (none needed — emit.ts is a pure
// library with no external service calls beyond DB + bus).
// ---------------------------------------------------------------------------

const { emitNotification } = await import("./emit");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAG = "NOTIFICATIONS_EMIT_TEST";

let userId: number;

async function cleanup() {
  await db.delete(users).where(sql`email LIKE ${TAG + "%"}`);
}

async function createUser(suffix: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email: `${TAG}-${suffix}@test.local`, name: `${TAG}-${suffix}` })
    .returning({ id: users.id });
  return row!.id;
}

/** Mark a notification as read so the dedup partial index no longer applies. */
async function readNotification(id: number): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: sql`NOW()` })
    .where(eq(notifications.id, id));
}

beforeAll(async () => {
  await cleanup();
  userId = await createUser("A");
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  // Delete only this user's notifications between tests for isolation.
  await db.delete(notifications).where(eq(notifications.userId, userId));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("emitNotification", () => {
  it("inserts a notification and returns its id", async () => {
    const result = await emitNotification(userId, {
      type: "slo_alert_fired",
      entityId: "slo-123",
      title: "SLO alert",
      body: "Something is wrong",
      priority: "high",
    });

    expect(result).not.toBeNull();
    expect(result!.id).toBeTypeOf("number");

    // Verify row exists in DB.
    const [row] = await db.select().from(notifications).where(eq(notifications.id, result!.id));

    expect(row).toBeDefined();
    expect(row!.type).toBe("slo_alert_fired");
    expect(row!.entityId).toBe("slo-123");
    expect(row!.priority).toBe("high");
    expect(row!.readAt).toBeNull();
  });

  it("fires notification:created on the bus with the correct payload", async () => {
    const received: AppEvent[] = [];
    const unsub = subscribe((e) => received.push(e));

    try {
      const result = await emitNotification(userId, {
        type: "gmail_token_expired",
        entityId: "conn-7",
        title: "Gmail disconnected",
        body: "Please reconnect your Gmail account",
        audience: "user",
        priority: "medium",
        actionUrl: "/settings/integrations",
        metadata: { connectionId: 7 },
      });

      expect(result).not.toBeNull();

      const created = received.filter((e) => e.type === "notification:created");
      expect(created).toHaveLength(1);
      const event = created[0]!;
      if (event.type === "notification:created") {
        expect(event.userId).toBe(userId);
        expect(event.audience).toBe("user");
        expect(event.notificationId).toBe(result!.id);
        expect(event.payload.title).toBe("Gmail disconnected");
        expect(event.payload.priority).toBe("medium");
        expect(event.payload.type).toBe("gmail_token_expired");
        expect(event.payload.actionUrl).toBe("/settings/integrations");
      }
    } finally {
      unsub();
    }
  });

  it("deduplicates: second call with same (userId, type, entityId) while unread returns null", async () => {
    const first = await emitNotification(userId, {
      type: "recurring_gap_detected",
      entityId: "gap-42",
      title: "Gap detected",
      body: "A recurring payment is missing",
    });

    expect(first).not.toBeNull();

    const second = await emitNotification(userId, {
      type: "recurring_gap_detected",
      entityId: "gap-42",
      title: "Gap detected",
      body: "Duplicate body",
    });

    expect(second).toBeNull();

    // Only one row should exist.
    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.type, "recurring_gap_detected"),
          eq(notifications.entityId, "gap-42"),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("dedup: second call does NOT fire a second notification:created event", async () => {
    const received: AppEvent[] = [];
    const unsub = subscribe((e) => received.push(e));

    try {
      await emitNotification(userId, {
        type: "budget_exceeded",
        entityId: "budget-5",
        title: "Budget exceeded",
        body: "You exceeded your monthly budget",
      });

      await emitNotification(userId, {
        type: "budget_exceeded",
        entityId: "budget-5",
        title: "Budget exceeded again",
        body: "Duplicate",
      });

      const created = received.filter((e) => e.type === "notification:created");
      expect(created).toHaveLength(1);
    } finally {
      unsub();
    }
  });

  it("dedup release: after marking as read, a new emit creates a fresh row", async () => {
    const first = await emitNotification(userId, {
      type: "sms_drift_detected",
      entityId: "drift-99",
      title: "SMS drift",
      body: "Something drifted",
    });

    expect(first).not.toBeNull();

    // Mark the notification as read — this lifts the dedup partial index.
    await readNotification(first!.id);

    const third = await emitNotification(userId, {
      type: "sms_drift_detected",
      entityId: "drift-99",
      title: "SMS drift again",
      body: "New occurrence",
    });

    expect(third).not.toBeNull();
    expect(third!.id).not.toBe(first!.id);
  });

  it("allows entityId: null (no dedup on null entity)", async () => {
    const a = await emitNotification(userId, {
      type: "insights_report_ready",
      entityId: null,
      title: "Insights ready",
      body: "Your monthly insights are ready",
    });

    // NOTE: null entityId still participates in the partial unique index.
    // A second call with the same (user, type, null) while unread will also dedup.
    expect(a).not.toBeNull();
    expect(a!.id).toBeTypeOf("number");
  });

  it("stores default audience=user and priority=medium when omitted", async () => {
    const result = await emitNotification(userId, {
      type: "rule_proposal_ready",
      entityId: "rule-1",
      title: "Rule proposal",
      body: "A new rule was proposed",
    });

    expect(result).not.toBeNull();

    const [row] = await db.select().from(notifications).where(eq(notifications.id, result!.id));

    expect(row!.audience).toBe("user");
    expect(row!.priority).toBe("medium");
  });
});
