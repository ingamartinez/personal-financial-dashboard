import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { notifications, users } from "@/lib/db/schema";
import { emit, subscribe, type AppEvent } from "@/lib/events/bus";
import { registerAutoMarkRead } from "./auto-mark-read";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAG = "NOTIFICATIONS_AUTO_MARK_READ_TEST";

let userA: number;
let userB: number;
let unregister: () => void;

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

async function createNotification(
  userId: number,
  opts: {
    type: string;
    entityId?: string | null;
    readAt?: Date | null;
  },
): Promise<number> {
  const [row] = await db
    .insert(notifications)
    .values({
      userId,
      type: opts.type,
      entityId: opts.entityId ?? null,
      audience: "user",
      title: "Test notification",
      body: "Test body",
      priority: "medium",
      metadata: {},
      readAt: opts.readAt ?? null,
    })
    .returning({ id: notifications.id });
  return row!.id;
}

async function getReadAt(id: number): Promise<Date | null> {
  const [row] = await db
    .select({ readAt: notifications.readAt })
    .from(notifications)
    .where(eq(notifications.id, id));
  return row?.readAt ?? null;
}

/**
 * Flush pending microtasks so async bus subscribers (which are async functions
 * called synchronously by the EventEmitter) have time to resolve their DB
 * calls before we assert.
 */
async function flush(): Promise<void> {
  // Two rounds of Promise.resolve ensures both the immediate microtask queue
  // and any awaited-within-subscribers work is settled.
  await new Promise<void>((r) => setTimeout(r, 50));
}

beforeAll(async () => {
  await cleanup();
  userA = await createUser("A");
  userB = await createUser("B");
  unregister = registerAutoMarkRead();
});

afterAll(async () => {
  unregister();
  await cleanup();
});

beforeEach(async () => {
  // Clean up notifications between tests.
  await db.delete(notifications).where(sql`${notifications.userId} IN (${userA}, ${userB})`);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerAutoMarkRead", () => {
  it("marks recurring_gap_detected notification as read on recurring-gap:resolved", async () => {
    const id = await createNotification(userA, {
      type: "recurring_gap_detected",
      entityId: "42",
    });

    emit({
      type: "recurring-gap:resolved",
      userId: userA,
      gapId: 42,
      reason: "linked",
      timestamp: Date.now(),
    });
    await flush();

    expect(await getReadAt(id)).not.toBeNull();
  });

  it("marks gmail_token_expired notification as read on gmail:reconnected", async () => {
    const id = await createNotification(userA, {
      type: "gmail_token_expired",
      entityId: "7",
    });

    emit({ type: "gmail:reconnected", userId: userA, connectionId: 7, timestamp: Date.now() });
    await flush();

    expect(await getReadAt(id)).not.toBeNull();
  });

  it("marks slo_alert_fired notification as read on slo:resolved", async () => {
    const id = await createNotification(userA, {
      type: "slo_alert_fired",
      entityId: "99",
    });

    emit({ type: "slo:resolved", userId: userA, alertId: 99, timestamp: Date.now() });
    await flush();

    expect(await getReadAt(id)).not.toBeNull();
  });

  it("marks gmail_disambiguation_required notification as read on disambiguation:resolved", async () => {
    const id = await createNotification(userA, {
      type: "gmail_disambiguation_required",
      entityId: "55",
    });

    emit({ type: "disambiguation:resolved", userId: userA, receiptId: 55, timestamp: Date.now() });
    await flush();

    expect(await getReadAt(id)).not.toBeNull();
  });

  it("no-ops when recurring-gap:resolved has gapId=null (synthetic auto-link)", async () => {
    const id = await createNotification(userA, {
      type: "recurring_gap_detected",
      entityId: null,
    });

    emit({
      type: "recurring-gap:resolved",
      userId: userA,
      gapId: null,
      reason: "synthetic",
      timestamp: Date.now(),
    });
    await flush();

    // readAt must remain null.
    expect(await getReadAt(id)).toBeNull();
  });

  it("does NOT touch another user's notifications", async () => {
    const idA = await createNotification(userA, {
      type: "slo_alert_fired",
      entityId: "10",
    });
    const idB = await createNotification(userB, {
      type: "slo_alert_fired",
      entityId: "10",
    });

    // Fire event for userA only.
    emit({ type: "slo:resolved", userId: userA, alertId: 10, timestamp: Date.now() });
    await flush();

    expect(await getReadAt(idA)).not.toBeNull();
    // B's notification must remain unread.
    expect(await getReadAt(idB)).toBeNull();
  });

  it("no-ops when entity_id does not match any notification", async () => {
    // Create a notification for entityId "1" but fire event for entityId "999".
    await createNotification(userA, {
      type: "slo_alert_fired",
      entityId: "1",
    });

    // Should not throw.
    emit({ type: "slo:resolved", userId: userA, alertId: 999, timestamp: Date.now() });
    await flush();

    // Original notification still unread.
    const rows = await db
      .select({ readAt: notifications.readAt })
      .from(notifications)
      .where(and(eq(notifications.userId, userA), eq(notifications.type, "slo_alert_fired")));
    expect(rows[0]!.readAt).toBeNull();
  });

  it("is idempotent: marking an already-read notification is a no-op (no error)", async () => {
    const id = await createNotification(userA, {
      type: "slo_alert_fired",
      entityId: "20",
      readAt: new Date(), // already read
    });

    // Should not throw.
    emit({ type: "slo:resolved", userId: userA, alertId: 20, timestamp: Date.now() });
    await flush();

    // readAt should still be set (no crash).
    expect(await getReadAt(id)).not.toBeNull();
  });

  it("does NOT emit notification:created when auto-marking as read", async () => {
    await createNotification(userA, {
      type: "gmail_token_expired",
      entityId: "30",
    });

    const received: AppEvent[] = [];
    const unsub = subscribe((e) => received.push(e));

    try {
      emit({ type: "gmail:reconnected", userId: userA, connectionId: 30, timestamp: Date.now() });
      await flush();

      const createdEvents = received.filter((e) => e.type === "notification:created");
      expect(createdEvents).toHaveLength(0);
    } finally {
      unsub();
    }
  });
});
