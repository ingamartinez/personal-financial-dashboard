import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, webhookTokens } from "@/lib/db/schema";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

// Session mock: the current user is controllable per test via setSessionUser.
const sessionState: { user: { id: number; email: string; name: string } | null } = {
  user: { id: 1, email: "test@findash.local", name: "Test" },
};

vi.mock("@/lib/auth/session", () => ({
  getSessionUser: vi.fn(async () => {
    if (!sessionState.user) throw new Error("UNAUTHENTICATED");
    return { ...sessionState.user, role: "user" as const, active: true };
  }),
  getSessionUserOrNull: vi.fn(async () => {
    if (!sessionState.user) return null;
    return { ...sessionState.user, role: "user" as const, active: true };
  }),
}));

function setSessionUser(user: { id: number; email: string; name: string } | null) {
  sessionState.user = user;
}

// Imported AFTER the mocks so they resolve to the stubs above.
const { mintWidgetTokenAction, revokeWidgetTokenAction } = await import("./actions");

const TEST_USER_ID = 1;
const LABEL_PREFIX = "vitest-widget-actions-";

function formData(input: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(input)) fd.set(k, v);
  return fd;
}

async function cleanup() {
  // Only nuke the test user's rows — cross-tenant tests seed their own user
  // in beforeAll and rely on that row surviving between tests.
  await db.execute(sql`
    DELETE FROM webhook_tokens
    WHERE user_id = ${TEST_USER_ID}
      AND purpose = 'widget'
      AND (label LIKE ${LABEL_PREFIX + "%"} OR label IS NULL)
  `);
}

describe("settings/widgets actions", () => {
  beforeEach(async () => {
    setSessionUser({ id: TEST_USER_ID, email: "test@findash.local", name: "Test" });
    await cleanup();
  });

  afterEach(cleanup);
  afterAll(async () => {
    await db.$client.end({ timeout: 1 });
  });

  describe("mintWidgetTokenAction", () => {
    it("mints a widget token for the authenticated user (happy path)", async () => {
      const result = await mintWidgetTokenAction(
        { status: "idle" },
        formData({ label: `${LABEL_PREFIX}scriptable` }),
      );

      expect(result.status).toBe("success");
      if (result.status !== "success") return;
      expect(result.plaintext).toMatch(/^[0-9a-f]{64}$/);
      expect(result.id).toBeGreaterThan(0);

      const [row] = await db.select().from(webhookTokens).where(eq(webhookTokens.id, result.id));
      expect(row.userId).toBe(TEST_USER_ID);
      expect(row.purpose).toBe("widget");
      expect(row.label).toBe(`${LABEL_PREFIX}scriptable`);
      expect(row.revokedAt).toBeNull();
    });

    it("allows minting without a label (mirrors webhook-tokens behavior)", async () => {
      const result = await mintWidgetTokenAction({ status: "idle" }, formData({ label: "" }));
      expect(result.status).toBe("success");
      if (result.status !== "success") return;

      const [row] = await db.select().from(webhookTokens).where(eq(webhookTokens.id, result.id));
      // Trim + empty → stored as null.
      expect(row.label).toBeNull();
      expect(row.purpose).toBe("widget");
    });

    it("returns an error when no session is present", async () => {
      setSessionUser(null);
      const result = await mintWidgetTokenAction(
        { status: "idle" },
        formData({ label: `${LABEL_PREFIX}no-session` }),
      );
      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.message).toMatch(/autenticado/i);

      // Nothing was written.
      const rows = await db
        .select()
        .from(webhookTokens)
        .where(
          and(
            eq(webhookTokens.userId, TEST_USER_ID),
            eq(webhookTokens.label, `${LABEL_PREFIX}no-session`),
          ),
        );
      expect(rows).toHaveLength(0);
    });
  });

  describe("revokeWidgetTokenAction", () => {
    it("revokes an owned token (happy path)", async () => {
      const mintRes = await mintWidgetTokenAction(
        { status: "idle" },
        formData({ label: `${LABEL_PREFIX}to-revoke` }),
      );
      if (mintRes.status !== "success") throw new Error("mint failed");

      await expect(revokeWidgetTokenAction({ tokenId: mintRes.id })).resolves.toBeUndefined();

      const [row] = await db.select().from(webhookTokens).where(eq(webhookTokens.id, mintRes.id));
      expect(row.revokedAt).not.toBeNull();
    });

    it("throws on an already-revoked token (mirrors webhook-tokens)", async () => {
      const mintRes = await mintWidgetTokenAction(
        { status: "idle" },
        formData({ label: `${LABEL_PREFIX}double-revoke` }),
      );
      if (mintRes.status !== "success") throw new Error("mint failed");

      await revokeWidgetTokenAction({ tokenId: mintRes.id });
      await expect(revokeWidgetTokenAction({ tokenId: mintRes.id })).rejects.toThrow();
    });

    it("throws when no session is present", async () => {
      const mintRes = await mintWidgetTokenAction(
        { status: "idle" },
        formData({ label: `${LABEL_PREFIX}auth-guard` }),
      );
      if (mintRes.status !== "success") throw new Error("mint failed");

      setSessionUser(null);
      await expect(revokeWidgetTokenAction({ tokenId: mintRes.id })).rejects.toThrow(
        /autenticado/i,
      );

      // Token was NOT revoked.
      const [row] = await db.select().from(webhookTokens).where(eq(webhookTokens.id, mintRes.id));
      expect(row.revokedAt).toBeNull();
    });
  });

  describe("cross-tenant enforcement", () => {
    const OTHER_USER_EMAIL = "__widgets_other@test.local";
    let otherUserId = 0;
    let otherTokenId = 0;

    beforeAll(async () => {
      const [u] = await db
        .insert(users)
        .values({ email: OTHER_USER_EMAIL, name: "Widgets Other" })
        .returning({ id: users.id });
      otherUserId = u.id;

      const [tok] = await db
        .insert(webhookTokens)
        .values({
          userId: otherUserId,
          purpose: "widget",
          tokenHash: "a".repeat(64),
          label: `${LABEL_PREFIX}other-user`,
        })
        .returning({ id: webhookTokens.id });
      otherTokenId = tok.id;
    });

    afterAll(async () => {
      await db.execute(sql`DELETE FROM webhook_tokens WHERE user_id = ${otherUserId}`);
      await db.execute(sql`DELETE FROM users WHERE email = ${OTHER_USER_EMAIL}`);
    });

    it("user A cannot revoke user B's widget token", async () => {
      // Session is user A (TEST_USER_ID). Target token belongs to otherUserId.
      setSessionUser({ id: TEST_USER_ID, email: "test@findash.local", name: "Test" });

      await expect(revokeWidgetTokenAction({ tokenId: otherTokenId })).rejects.toThrow(
        /no encontrado|no te pertenece/i,
      );

      // Other user's token is STILL active.
      const [row] = await db.select().from(webhookTokens).where(eq(webhookTokens.id, otherTokenId));
      expect(row.revokedAt).toBeNull();
      expect(row.userId).toBe(otherUserId);
    });
  });
});
