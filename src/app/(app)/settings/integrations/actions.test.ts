import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { gmailConnections, users } from "@/lib/db/schema";
import { gmailCipher } from "@/lib/crypto/gmail-cipher";

// ---------------------------------------------------------------------------
// Hoist shared mocks before module imports.
// ---------------------------------------------------------------------------

const { mockGetSessionUser, mockPullForUser } = vi.hoisted(() => ({
  mockGetSessionUser: vi.fn(),
  mockPullForUser: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getSessionUser: mockGetSessionUser,
}));

vi.mock("@/lib/gmail/pull", () => ({
  pullForUser: mockPullForUser,
}));

// ---------------------------------------------------------------------------
// Lazy import AFTER mocks are registered so the module resolves the mocked
// dependencies.
// ---------------------------------------------------------------------------

const { setBootstrapSinceDateAction, triggerIncrementalPullAction, triggerRebootstrapAction } =
  await import("./actions");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAG = "INTEGRATIONS_ACTIONS_TEST";
const ORIGINAL_GMAIL_KEY = process.env.GMAIL_TOKEN_ENCRYPTION_KEY;

let userA: number;
let connA: number;
let userB: number;
let connB: number;

async function cleanup() {
  await db.delete(users).where(sql`email LIKE ${TAG + "%"}`);
}

async function createUser(suffix: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email: `${TAG}-${suffix}@test.local`, name: `${TAG}-${suffix}` })
    .returning({ id: users.id });
  return row.id;
}

async function createConnection(userId: number): Promise<number> {
  const [row] = await db
    .insert(gmailConnections)
    .values({
      userId,
      gmailEmail: `${TAG}-${userId}@gmail.com`,
      accessTokenEnc: gmailCipher.encrypt("dummy-access"),
      refreshTokenEnc: gmailCipher.encrypt("dummy-refresh"),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "active",
    })
    .returning({ id: gmailConnections.id });
  return row.id;
}

beforeAll(async () => {
  // Set a dummy 32-byte key so gmailCipher.encrypt works in tests.
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  await cleanup();
  userA = await createUser("A");
  connA = await createConnection(userA);
  userB = await createUser("B");
  connB = await createConnection(userB);
});

afterAll(async () => {
  await cleanup();
  if (ORIGINAL_GMAIL_KEY === undefined) delete process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
  else process.env.GMAIL_TOKEN_ENCRYPTION_KEY = ORIGINAL_GMAIL_KEY;
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// setBootstrapSinceDateAction
// ---------------------------------------------------------------------------

describe("setBootstrapSinceDateAction", () => {
  it("sets bootstrapSinceDate for the authenticated user's connection", async () => {
    mockGetSessionUser.mockResolvedValue({ id: userA });
    const date = new Date("2026-01-01T00:00:00Z");

    const result = await setBootstrapSinceDateAction(date);

    expect(result).toEqual({ ok: true });

    const [row] = await db
      .select({ bootstrapSinceDate: gmailConnections.bootstrapSinceDate })
      .from(gmailConnections)
      .where(eq(gmailConnections.id, connA));

    expect(row.bootstrapSinceDate).toEqual(date);
  });

  it("accepts null to clear the date", async () => {
    mockGetSessionUser.mockResolvedValue({ id: userA });

    // First set a date.
    await setBootstrapSinceDateAction(new Date("2026-03-01T00:00:00Z"));
    // Then clear it.
    const result = await setBootstrapSinceDateAction(null);

    expect(result).toEqual({ ok: true });

    const [row] = await db
      .select({ bootstrapSinceDate: gmailConnections.bootstrapSinceDate })
      .from(gmailConnections)
      .where(eq(gmailConnections.id, connA));

    expect(row.bootstrapSinceDate).toBeNull();
  });

  it("does NOT update another user's connection (tenant safety)", async () => {
    // userA sets a date. userB's connection must be unaffected.
    mockGetSessionUser.mockResolvedValue({ id: userA });
    const dateA = new Date("2026-02-01T00:00:00Z");
    await setBootstrapSinceDateAction(dateA);

    const [rowB] = await db
      .select({ bootstrapSinceDate: gmailConnections.bootstrapSinceDate })
      .from(gmailConnections)
      .where(eq(gmailConnections.id, connB));

    // userB's row should still be whatever it was (never touched by userA's action).
    // The WHERE clause is scoped to session.id so the UPDATE only hits connA.
    // connB's bootstrap_since_date should NOT equal dateA.
    expect(rowB.bootstrapSinceDate).not.toEqual(dateA);
  });
});

// ---------------------------------------------------------------------------
// triggerIncrementalPullAction
// ---------------------------------------------------------------------------

describe("triggerIncrementalPullAction", () => {
  it("returns { triggered: true } immediately without awaiting the pull", async () => {
    mockGetSessionUser.mockResolvedValue({ id: userA });
    // pullForUser returns a promise that never resolves during this test —
    // the action must not await it.
    mockPullForUser.mockReturnValue(new Promise(() => {}));

    const result = await triggerIncrementalPullAction();

    expect(result).toEqual({ triggered: true });
  });

  it("does not pass overrideSince to pullForUser (uses cursor)", async () => {
    mockGetSessionUser.mockResolvedValue({ id: userA });
    mockPullForUser.mockResolvedValue({});

    await triggerIncrementalPullAction();

    // Allow the microtask to drain.
    await new Promise((r) => setTimeout(r, 0));

    // The action calls pullForUser(userId) with NO opts — uses the cursor.
    expect(mockPullForUser).toHaveBeenCalledWith(userA);
    const call = mockPullForUser.mock.calls[0];
    // Second argument must be absent or not contain overrideSince.
    expect(call[1]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// triggerRebootstrapAction
// ---------------------------------------------------------------------------

describe("triggerRebootstrapAction", () => {
  it("returns { triggered: true } immediately", async () => {
    mockGetSessionUser.mockResolvedValue({ id: userA });
    mockPullForUser.mockReturnValue(new Promise(() => {}));

    const result = await triggerRebootstrapAction();

    expect(result).toEqual({ triggered: true });
  });

  it("passes overrideSince set to the stored bootstrapSinceDate", async () => {
    mockGetSessionUser.mockResolvedValue({ id: userA });
    mockPullForUser.mockResolvedValue({});

    // Pre-set a bootstrapSinceDate on connA.
    const bootstrap = new Date("2026-01-10T00:00:00Z");
    await db
      .update(gmailConnections)
      .set({ bootstrapSinceDate: bootstrap })
      .where(and(eq(gmailConnections.id, connA)));

    await triggerRebootstrapAction();

    // Drain the queueMicrotask.
    await new Promise((r) => setTimeout(r, 0));

    expect(mockPullForUser).toHaveBeenCalledWith(
      userA,
      expect.objectContaining({ overrideSince: bootstrap }),
    );
  });

  it("falls back to Jan 1 of current year when bootstrapSinceDate is null", async () => {
    mockGetSessionUser.mockResolvedValue({ id: userA });
    mockPullForUser.mockResolvedValue({});

    // Clear the date.
    await db
      .update(gmailConnections)
      .set({ bootstrapSinceDate: null })
      .where(and(eq(gmailConnections.id, connA)));

    await triggerRebootstrapAction();
    await new Promise((r) => setTimeout(r, 0));

    const jan1 = new Date(new Date().getFullYear(), 0, 1);
    expect(mockPullForUser).toHaveBeenCalledWith(
      userA,
      expect.objectContaining({
        overrideSince: expect.any(Date),
      }),
    );
    const call = mockPullForUser.mock.calls[0];
    const overrideSince = (call[1] as { overrideSince: Date }).overrideSince;
    expect(overrideSince.getFullYear()).toBe(jan1.getFullYear());
    expect(overrideSince.getMonth()).toBe(0);
    expect(overrideSince.getDate()).toBe(1);
  });
});
