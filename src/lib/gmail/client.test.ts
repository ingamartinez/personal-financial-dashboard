import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { gmailConnections, users } from "@/lib/db/schema";
import { gmailCipher } from "@/lib/crypto/gmail-cipher";
import {
  GMAIL_SCOPES,
  GmailConnectionUnusableError,
  GmailNotConnectedError,
  getAuthedClient,
  isInvalidGrantError,
  markConnectionUnusable,
} from "./client";

const TAG = "GMAIL_CLIENT_TEST";

let userA: number;
let userB: number;
const ORIGINAL_AUTH_GOOGLE_ID = process.env.AUTH_GOOGLE_ID;
const ORIGINAL_AUTH_GOOGLE_SECRET = process.env.AUTH_GOOGLE_SECRET;
const ORIGINAL_REDIRECT_URI = process.env.GMAIL_OAUTH_REDIRECT_URI;
const ORIGINAL_GMAIL_KEY = process.env.GMAIL_TOKEN_ENCRYPTION_KEY;

async function cleanup(): Promise<void> {
  await db.delete(users).where(sql`email LIKE ${TAG + "%"}`);
}

async function createUser(suffix: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email: `${TAG}-${suffix}@test.local`, name: `${TAG}-${suffix}` })
    .returning({ id: users.id });
  return row.id;
}

async function seedConnection(
  userId: number,
  opts: { status?: "active" | "expired" | "revoked" } = {},
) {
  const [row] = await db
    .insert(gmailConnections)
    .values({
      userId,
      gmailEmail: `${TAG}-${userId}@example.com`,
      accessTokenEnc: gmailCipher.encrypt("dummy-access-token"),
      refreshTokenEnc: gmailCipher.encrypt("dummy-refresh-token"),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: opts.status ?? "active",
      statusReason: opts.status && opts.status !== "active" ? "test reason" : null,
    })
    .returning({ id: gmailConnections.id });
  return row.id;
}

describe("gmail/client", () => {
  beforeAll(async () => {
    // Required by getAuthedClient → loadOAuthEnv. The values don't have to
    // be real Google credentials — we never actually call the network here.
    process.env.AUTH_GOOGLE_ID = "test-client-id.apps.googleusercontent.com";
    process.env.AUTH_GOOGLE_SECRET = "test-client-secret";
    process.env.GMAIL_OAUTH_REDIRECT_URI =
      "http://localhost:3100/api/integrations/gmail/oauth/callback";
    // gmailCipher reads this lazily; vitest.setup.ts sets the Telegram one
    // but not the Gmail one. Use the same deterministic key.
    process.env.GMAIL_TOKEN_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

    await cleanup();
    userA = await createUser("A");
    userB = await createUser("B");
  });

  beforeEach(async () => {
    await db.delete(gmailConnections).where(sql`user_id IN (${userA}, ${userB})`);
  });

  afterAll(async () => {
    await cleanup();
    if (ORIGINAL_AUTH_GOOGLE_ID === undefined) delete process.env.AUTH_GOOGLE_ID;
    else process.env.AUTH_GOOGLE_ID = ORIGINAL_AUTH_GOOGLE_ID;
    if (ORIGINAL_AUTH_GOOGLE_SECRET === undefined) delete process.env.AUTH_GOOGLE_SECRET;
    else process.env.AUTH_GOOGLE_SECRET = ORIGINAL_AUTH_GOOGLE_SECRET;
    if (ORIGINAL_REDIRECT_URI === undefined) delete process.env.GMAIL_OAUTH_REDIRECT_URI;
    else process.env.GMAIL_OAUTH_REDIRECT_URI = ORIGINAL_REDIRECT_URI;
    if (ORIGINAL_GMAIL_KEY === undefined) delete process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
    else process.env.GMAIL_TOKEN_ENCRYPTION_KEY = ORIGINAL_GMAIL_KEY;
    // Do NOT call db.$client.end() — see gmail-isolation.test.ts for why.
  });

  // -------------------------------------------------------------------------
  // Scope set — sentinel for #462
  // -------------------------------------------------------------------------

  it("GMAIL_SCOPES includes userinfo.email so the callback's userinfo.get() works", () => {
    // Without this scope the access token returned post-consent has only
    // gmail.readonly, and google.oauth2(...).userinfo.get() returns 401
    // UNAUTHENTICATED. The first connect-after-NextAuth-login may seem to
    // work via include_granted_scopes inheriting the email grant, but a
    // disconnect+reconnect cycle exposes the gap (revokeToken wipes all
    // grants at Google).
    expect(GMAIL_SCOPES).toContain("https://www.googleapis.com/auth/userinfo.email");
    expect(GMAIL_SCOPES).toContain("https://www.googleapis.com/auth/gmail.readonly");
  });

  // -------------------------------------------------------------------------
  // Tenant isolation — explicit acceptance criterion of #451
  // -------------------------------------------------------------------------

  it("getAuthedClient throws GmailNotConnectedError for a user with no connection", async () => {
    await expect(getAuthedClient(userA)).rejects.toThrow(GmailNotConnectedError);
  });

  it("getAuthedClient called with userB's id never returns userA's connection", async () => {
    await seedConnection(userA);
    await expect(getAuthedClient(userB)).rejects.toThrow(GmailNotConnectedError);
  });

  it("getAuthedClient returns userA's connection for userA", async () => {
    const connId = await seedConnection(userA);
    const result = await getAuthedClient(userA);
    expect(result.connection.id).toBe(connId);
    expect(result.connection.gmailEmail).toBe(`${TAG}-${userA}@example.com`);
  });

  it("getAuthedClient ignores soft-deleted rows", async () => {
    const connId = await seedConnection(userA);
    await db
      .update(gmailConnections)
      .set({ deletedAt: new Date() })
      .where(eq(gmailConnections.id, connId));
    await expect(getAuthedClient(userA)).rejects.toThrow(GmailNotConnectedError);
  });

  // -------------------------------------------------------------------------
  // Connection status transitions
  // -------------------------------------------------------------------------

  it("getAuthedClient throws GmailConnectionUnusableError when status='expired'", async () => {
    await seedConnection(userA, { status: "expired" });
    await expect(getAuthedClient(userA)).rejects.toThrow(GmailConnectionUnusableError);
    try {
      await getAuthedClient(userA);
    } catch (err) {
      expect(err).toBeInstanceOf(GmailConnectionUnusableError);
      const e = err as GmailConnectionUnusableError;
      expect(e.status).toBe("expired");
      expect(e.reason).toBe("test reason");
    }
  });

  it("getAuthedClient throws GmailConnectionUnusableError when status='revoked'", async () => {
    await seedConnection(userA, { status: "revoked" });
    await expect(getAuthedClient(userA)).rejects.toThrow(GmailConnectionUnusableError);
  });

  it("markConnectionUnusable transitions an active row to expired with reason", async () => {
    const connId = await seedConnection(userA);
    await markConnectionUnusable(connId, "expired", "invalid_grant from Google refresh");
    const [row] = await db
      .select({ status: gmailConnections.status, reason: gmailConnections.statusReason })
      .from(gmailConnections)
      .where(eq(gmailConnections.id, connId));
    expect(row.status).toBe("expired");
    expect(row.reason).toBe("invalid_grant from Google refresh");
  });

  it("markConnectionUnusable is idempotent", async () => {
    const connId = await seedConnection(userA);
    await markConnectionUnusable(connId, "expired", "first");
    await markConnectionUnusable(connId, "expired", "second");
    const [row] = await db
      .select({ status: gmailConnections.status, reason: gmailConnections.statusReason })
      .from(gmailConnections)
      .where(eq(gmailConnections.id, connId));
    expect(row.status).toBe("expired");
    expect(row.reason).toBe("second");
  });

  // -------------------------------------------------------------------------
  // Token encryption invariant — acceptance criterion of #451
  // -------------------------------------------------------------------------

  it("seeded tokens are stored encrypted (raw column does NOT contain plaintext)", async () => {
    await seedConnection(userA);
    const [row] = await db
      .select({
        accessTokenEnc: gmailConnections.accessTokenEnc,
        refreshTokenEnc: gmailConnections.refreshTokenEnc,
      })
      .from(gmailConnections)
      .where(eq(gmailConnections.userId, userA));
    expect(row.accessTokenEnc).not.toContain("dummy-access-token");
    expect(row.refreshTokenEnc).not.toContain("dummy-refresh-token");
    // Round-trips back through the cipher.
    expect(gmailCipher.decrypt(row.accessTokenEnc)).toBe("dummy-access-token");
  });

  // -------------------------------------------------------------------------
  // isInvalidGrantError — used by downstream callers to drive markConnectionUnusable
  // -------------------------------------------------------------------------

  it("isInvalidGrantError detects the structured Google error response", () => {
    const err = { response: { data: { error: "invalid_grant" } }, message: "Bad Request" };
    expect(isInvalidGrantError(err)).toBe(true);
  });

  it("isInvalidGrantError detects via message string fallback", () => {
    const err = { message: "Token has been expired or revoked. invalid_grant." };
    expect(isInvalidGrantError(err)).toBe(true);
  });

  it("isInvalidGrantError returns false for unrelated errors", () => {
    expect(isInvalidGrantError(new Error("network down"))).toBe(false);
    expect(isInvalidGrantError({ response: { data: { error: "rate_limit" } } })).toBe(false);
    expect(isInvalidGrantError(null)).toBe(false);
    expect(isInvalidGrantError("string error")).toBe(false);
  });
});
