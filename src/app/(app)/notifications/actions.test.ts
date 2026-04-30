import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { notifications, users } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Hoist shared mocks before module imports.
// ---------------------------------------------------------------------------

const { mockGetSessionUser } = vi.hoisted(() => ({
  mockGetSessionUser: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getSessionUser: mockGetSessionUser,
}));

// ---------------------------------------------------------------------------
// Lazy import AFTER mocks are registered.
// ---------------------------------------------------------------------------

const { listNotifications, markAllAsRead, markAsRead, unreadCount } = await import("./actions");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAG = "NOTIFICATIONS_ACTIONS_TEST";

let userA: number;
let userB: number;

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
    type?: string;
    entityId?: string | null;
    title?: string;
    readAt?: Date | null;
  } = {},
): Promise<number> {
  const [row] = await db
    .insert(notifications)
    .values({
      userId,
      type: opts.type ?? "slo_alert_fired",
      entityId: opts.entityId ?? null,
      audience: "user",
      title: opts.title ?? "Test notification",
      body: "Test body",
      priority: "medium",
      metadata: {},
      readAt: opts.readAt ?? null,
    })
    .returning({ id: notifications.id });
  return row!.id;
}

beforeAll(async () => {
  await cleanup();
  userA = await createUser("A");
  userB = await createUser("B");
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  // Clean up notifications between tests.
  await db.delete(notifications).where(sql`${notifications.userId} IN (${userA}, ${userB})`);
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// listNotifications
// ---------------------------------------------------------------------------

describe("listNotifications", () => {
  it("returns only the calling user's notifications", async () => {
    mockGetSessionUser.mockResolvedValue({ id: userA });
    await createNotification(userA, { title: "A's notification" });
    await createNotification(userB, { title: "B's notification" });

    const result = await listNotifications();

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.title).toBe("A's notification");
  });

  it("excludes read notifications when unreadOnly=true", async () => {
    mockGetSessionUser.mockResolvedValue({ id: userA });
    await createNotification(userA, { title: "Unread" });
    await createNotification(userA, { title: "Read", readAt: new Date() });

    const result = await listNotifications({ unreadOnly: true });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.title).toBe("Unread");
  });

  it("includes read notifications by default", async () => {
    mockGetSessionUser.mockResolvedValue({ id: userA });
    await createNotification(userA, { title: "Unread" });
    await createNotification(userA, { title: "Read", readAt: new Date() });

    const result = await listNotifications();

    expect(result.items).toHaveLength(2);
  });

  it("returns nextCursor when there are more items", async () => {
    mockGetSessionUser.mockResolvedValue({ id: userA });
    // Create 3 notifications; fetch with limit=2.
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await createNotification(userA, { title: `Notif ${i}` }));
    }

    const page1 = await listNotifications({ limit: 2 });

    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
  });

  it("cursor pagination: second page does not overlap with first", async () => {
    mockGetSessionUser.mockResolvedValue({ id: userA });
    for (let i = 0; i < 4; i++) {
      await createNotification(userA, { title: `Notif ${i}` });
    }

    const page1 = await listNotifications({ limit: 2 });
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listNotifications({ limit: 2, cursor: page1.nextCursor! });

    // No ids should appear in both pages.
    const page1Ids = new Set(page1.items.map((r) => r.id));
    const page2Ids = page2.items.map((r) => r.id);
    for (const id of page2Ids) {
      expect(page1Ids.has(id)).toBe(false);
    }
  });

  it("nextCursor is null on the last page", async () => {
    mockGetSessionUser.mockResolvedValue({ id: userA });
    await createNotification(userA, { title: "Only one" });

    const result = await listNotifications({ limit: 10 });

    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// markAsRead
// ---------------------------------------------------------------------------

describe("markAsRead", () => {
  it("marks the calling user's notification as read", async () => {
    mockGetSessionUser.mockResolvedValue({ id: userA });
    const id = await createNotification(userA);

    const result = await markAsRead(id);

    expect(result).toEqual({ ok: true });

    const [row] = await db
      .select({ readAt: notifications.readAt })
      .from(notifications)
      .where(eq(notifications.id, id));
    expect(row!.readAt).not.toBeNull();
  });

  it("returns not-found when id belongs to another user", async () => {
    mockGetSessionUser.mockResolvedValue({ id: userA });
    const idB = await createNotification(userB);

    const result = await markAsRead(idB);

    expect(result).toEqual({ ok: false, reason: "not-found" });

    // B's notification must not be mutated.
    const [row] = await db
      .select({ readAt: notifications.readAt })
      .from(notifications)
      .where(eq(notifications.id, idB));
    expect(row!.readAt).toBeNull();
  });

  it("is idempotent: already-read notification returns ok", async () => {
    mockGetSessionUser.mockResolvedValue({ id: userA });
    const id = await createNotification(userA, { readAt: new Date() });

    const result = await markAsRead(id);

    expect(result).toEqual({ ok: true });
  });

  it("returns not-found for non-existent id", async () => {
    mockGetSessionUser.mockResolvedValue({ id: userA });

    const result = await markAsRead(999_999_999);

    expect(result).toEqual({ ok: false, reason: "not-found" });
  });
});

// ---------------------------------------------------------------------------
// markAllAsRead
// ---------------------------------------------------------------------------

describe("markAllAsRead", () => {
  it("marks only the calling user's unread notifications", async () => {
    mockGetSessionUser.mockResolvedValue({ id: userA });
    await createNotification(userA, { title: "A unread 1" });
    await createNotification(userA, { title: "A unread 2" });
    await createNotification(userA, { title: "A already read", readAt: new Date() });
    const bId = await createNotification(userB, { title: "B unread" });

    const result = await markAllAsRead();

    expect(result).toEqual({ count: 2 });

    // B's notification must remain unread.
    const [bRow] = await db
      .select({ readAt: notifications.readAt })
      .from(notifications)
      .where(eq(notifications.id, bId));
    expect(bRow!.readAt).toBeNull();
  });

  it("returns count=0 when there are no unread notifications", async () => {
    mockGetSessionUser.mockResolvedValue({ id: userA });
    await createNotification(userA, { readAt: new Date() });

    const result = await markAllAsRead();

    expect(result).toEqual({ count: 0 });
  });
});

// ---------------------------------------------------------------------------
// unreadCount
// ---------------------------------------------------------------------------

describe("unreadCount", () => {
  it("returns the number of unread notifications for the user", async () => {
    mockGetSessionUser.mockResolvedValue({ id: userA });
    await createNotification(userA);
    await createNotification(userA);
    await createNotification(userA, { readAt: new Date() });
    // B's notifications do not count.
    await createNotification(userB);

    const result = await unreadCount();

    expect(result).toEqual({ count: 2 });
  });

  it("returns 0 when there are no unread notifications", async () => {
    mockGetSessionUser.mockResolvedValue({ id: userA });
    await createNotification(userA, { readAt: new Date() });

    const result = await unreadCount();

    expect(result).toEqual({ count: 0 });
  });
});
