import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailReceipts, gmailConnections, gmailPullCursors, users } from "@/lib/db/schema";
import { gmailCipher } from "@/lib/crypto/gmail-cipher";
import type { AuthedGmailClient } from "./client";
import { GmailConnectionUnusableError, GmailNotConnectedError } from "./client";
import { pullForUser, computeSinceDate, type PullOpts } from "./pull";

const TAG = "GMAIL_PULL_TEST";

let userA: number;
let userB: number;

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

async function seedActiveConnection(
  userId: number,
  extras: { lastPullAt?: Date } = {},
): Promise<number> {
  const [row] = await db
    .insert(gmailConnections)
    .values({
      userId,
      gmailEmail: `${TAG}-${userId}@example.com`,
      accessTokenEnc: gmailCipher.encrypt("dummy-access-token"),
      refreshTokenEnc: gmailCipher.encrypt("dummy-refresh-token"),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "active",
      lastPullAt: extras.lastPullAt,
    })
    .returning({ id: gmailConnections.id });
  return row.id;
}

async function seedPullCursor(
  userId: number,
  connectionId: number,
  gateway: "mercado_pago" | "payu",
  lastPullAt: Date,
): Promise<void> {
  await db.insert(gmailPullCursors).values({ userId, connectionId, gateway, lastPullAt });
}

// Extracts the `after:<unix-seconds>` fragment from a Gmail list q. The
// since-date is the thing under test in the #511 specs; the sender-query
// prefix is covered by the registry tests, so a substring check for the
// gateway's domain + this extraction pins the watermark exactly.
function afterSecondsOf(q: string | undefined): number | null {
  const match = q?.match(/after:(\d+)/);
  return match ? Number(match[1]) : null;
}

// Build a fake message payload with a single text/html part. Body is
// base64url-encoded per the Gmail API contract. `internalDate` is the
// stringified epoch milliseconds Gmail returns for every message — when
// provided we propagate it so tests can assert receipt.emailReceivedAt
// (#545).
function fakeMessage(
  id: string,
  html: string,
  opts?: { internalDate?: string },
): { data: { payload: unknown; id: string; internalDate?: string } } {
  const encoded = Buffer.from(html, "utf8").toString("base64url");
  return {
    data: {
      id,
      ...(opts?.internalDate ? { internalDate: opts.internalDate } : {}),
      payload: {
        mimeType: "text/html",
        body: { data: encoded },
      },
    },
  };
}

interface ListCall {
  q: string | undefined;
  pageToken: string | undefined;
}

interface GetCall {
  id: string;
}

// Minimal Gmail API surface matching what pullForUser uses. Keeps the
// tests self-contained and deterministic — no mocking library, no real
// googleapis HTTP client.
function fakeAuthed(opts: {
  userId: number;
  connectionId: number;
  gmailEmail: string;
  onList: (call: ListCall) => { messageIds: string[]; nextPageToken?: string };
  onGet?: (call: GetCall) => ReturnType<typeof fakeMessage> | Promise<unknown>;
}): {
  authed: AuthedGmailClient;
  listCalls: ListCall[];
  getCalls: GetCall[];
} {
  const listCalls: ListCall[] = [];
  const getCalls: GetCall[] = [];
  const onGet =
    opts.onGet ??
    ((call: GetCall) => fakeMessage(call.id, `<html><body>body for ${call.id}</body></html>`));
  const authed = {
    oauth: {} as unknown,
    gmail: {
      users: {
        messages: {
          async list(params: { q?: string; pageToken?: string }) {
            listCalls.push({ q: params.q, pageToken: params.pageToken });
            const { messageIds, nextPageToken } = opts.onList({
              q: params.q,
              pageToken: params.pageToken,
            });
            return {
              data: {
                messages: messageIds.map((id) => ({ id, threadId: id })),
                nextPageToken,
              },
            };
          },
          async get(params: { id: string }) {
            getCalls.push({ id: params.id });
            return await onGet({ id: params.id });
          },
        },
      },
    },
    connection: { id: opts.connectionId, gmailEmail: opts.gmailEmail, accessTokenStale: false },
  } as unknown as AuthedGmailClient;
  return { authed, listCalls, getCalls };
}

// Exact Gmail `q` for a jetsmart historical window. Substring checks on the
// domain would also accept a wrong query that merely mentioned jetsmart.com.
function jetsmartHistoricalQuery(since: Date, until: Date): string {
  return `from:(@jetsmart.com) after:${Math.floor(since.getTime() / 1000)} before:${Math.floor(until.getTime() / 1000)}`;
}

describe("gmail/pull", () => {
  beforeAll(async () => {
    process.env.GMAIL_TOKEN_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    await cleanup();
    userA = await createUser("A");
    userB = await createUser("B");
  });

  beforeEach(async () => {
    await db.delete(emailReceipts).where(sql`user_id IN (${userA}, ${userB})`);
    await db.delete(gmailConnections).where(sql`user_id IN (${userA}, ${userB})`);
  });

  afterAll(async () => {
    await cleanup();
    if (ORIGINAL_GMAIL_KEY === undefined) delete process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
    else process.env.GMAIL_TOKEN_ENCRYPTION_KEY = ORIGINAL_GMAIL_KEY;
    // See gmail-isolation.test.ts — only that file may call db.$client.end().
  });

  // -------------------------------------------------------------------------
  // Not-connected + unusable connection paths (acceptance criterion: graceful
  // return, not throw; caller surfaces a reconnect nudge).
  // -------------------------------------------------------------------------

  it("returns empty result with connectionId null when user has no connection", async () => {
    const getClient = async () => {
      throw new GmailNotConnectedError(userA);
    };
    const result = await pullForUser(userA, {}, { getClient });
    expect(result.connectionId).toBeNull();
    expect(result.pulled).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns an 'auth' error when connection is marked expired", async () => {
    const getClient = async () => {
      throw new GmailConnectionUnusableError("expired", "refresh token expired");
    };
    const result = await pullForUser(userA, {}, { getClient });
    expect(result.connectionId).toBeNull();
    expect(result.pulled).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].phase).toBe("auth");
    expect(result.errors[0].code).toBe("expired");
  });

  // -------------------------------------------------------------------------
  // Happy path + idempotency
  // -------------------------------------------------------------------------

  it("inserts new email_receipts rows scoped to userId; watermark advances on success", async () => {
    const connId = await seedActiveConnection(userA);
    const { authed, listCalls, getCalls } = fakeAuthed({
      userId: userA,
      connectionId: connId,
      gmailEmail: `${TAG}-${userA}@example.com`,
      onList: (call) => {
        // Only the mercado_pago gateway returns messages. All others return
        // empty, so we verify the per-gateway query + insert behavior.
        if (call.q?.includes("mercadopago.com.co")) {
          return { messageIds: ["mp-msg-1", "mp-msg-2"] };
        }
        return { messageIds: [] };
      },
    });

    const now = new Date("2026-04-24T12:00:00Z");
    const result = await pullForUser(
      userA,
      { gateways: ["mercado_pago", "payu"] },
      { getClient: async () => authed, now: () => now },
    );

    expect(result.connectionId).toBe(connId);
    expect(result.pulled).toBe(2);
    expect(result.byGateway.mercado_pago.pulled).toBe(2);
    expect(result.byGateway.payu.pulled).toBe(0);
    expect(result.errors).toHaveLength(0);
    // one list call per gateway (no pagination needed for 2 msgs)
    expect(listCalls).toHaveLength(2);
    expect(getCalls).toHaveLength(2);

    const rows = await db
      .select({
        msgId: emailReceipts.gmailMsgId,
        gateway: emailReceipts.gateway,
        userId: emailReceipts.userId,
        rawHtml: emailReceipts.rawHtml,
      })
      .from(emailReceipts)
      .where(eq(emailReceipts.userId, userA));
    expect(rows.map((r) => r.msgId).sort()).toEqual(["mp-msg-1", "mp-msg-2"]);
    expect(rows.every((r) => r.gateway === "mercado_pago")).toBe(true);
    expect(rows.every((r) => r.userId === userA)).toBe(true);
    expect(rows.every((r) => r.rawHtml.includes("body for"))).toBe(true);

    const [conn] = await db
      .select({ lastPullAt: gmailConnections.lastPullAt })
      .from(gmailConnections)
      .where(eq(gmailConnections.id, connId));
    expect(conn.lastPullAt?.getTime()).toBe(now.getTime());
  });

  it("is idempotent — running twice in a row does not re-ingest", async () => {
    const connId = await seedActiveConnection(userA);
    let listCount = 0;
    const { authed } = fakeAuthed({
      userId: userA,
      connectionId: connId,
      gmailEmail: `${TAG}-${userA}@example.com`,
      onList: (call) => {
        if (call.q?.includes("mercadopago.com.co")) {
          listCount++;
          return { messageIds: ["mp-msg-1", "mp-msg-2"] };
        }
        return { messageIds: [] };
      },
    });

    const first = await pullForUser(
      userA,
      { gateways: ["mercado_pago"] },
      { getClient: async () => authed },
    );
    expect(first.pulled).toBe(2);
    expect(first.skipped).toBe(0);

    const second = await pullForUser(
      userA,
      { gateways: ["mercado_pago"] },
      { getClient: async () => authed },
    );
    expect(second.pulled).toBe(0);
    expect(second.skipped).toBe(2);
    expect(listCount).toBe(2);

    const rows = await db
      .select({ msgId: emailReceipts.gmailMsgId })
      .from(emailReceipts)
      .where(eq(emailReceipts.userId, userA));
    expect(rows).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Tenant isolation — THE acceptance criterion of #452.
  // -------------------------------------------------------------------------

  it("pullForUser(A) does not write a row with user_id=B even if B has a connection", async () => {
    const connA = await seedActiveConnection(userA);
    await seedActiveConnection(userB);

    const { authed } = fakeAuthed({
      userId: userA,
      connectionId: connA,
      gmailEmail: `${TAG}-${userA}@example.com`,
      onList: (call) => {
        if (call.q?.includes("mercadopago.com.co")) return { messageIds: ["shared-msg-1"] };
        return { messageIds: [] };
      },
    });

    await pullForUser(userA, { gateways: ["mercado_pago"] }, { getClient: async () => authed });

    const rowsA = await db
      .select({ msgId: emailReceipts.gmailMsgId })
      .from(emailReceipts)
      .where(eq(emailReceipts.userId, userA));
    const rowsB = await db
      .select({ msgId: emailReceipts.gmailMsgId })
      .from(emailReceipts)
      .where(eq(emailReceipts.userId, userB));
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(0);
  });

  it("pullForUser(A) idempotency is not confused by a different user holding the same msg_id", async () => {
    // Simulate the edge case where userB already has a row with the same
    // Gmail message id (they would only ever collide if both users
    // connected the same Gmail account — unlikely but the unique index is
    // scoped per-user, so the pull must NOT treat B's row as already-seen
    // for A.
    const connA = await seedActiveConnection(userA);
    const connB = await seedActiveConnection(userB);
    await db.insert(emailReceipts).values({
      userId: userB,
      gmailConnectionId: connB,
      gmailMsgId: "shared-msg-1",
      gateway: "mercado_pago",
      rawHtml: "B's copy",
    });

    const { authed } = fakeAuthed({
      userId: userA,
      connectionId: connA,
      gmailEmail: `${TAG}-${userA}@example.com`,
      onList: (call) => {
        if (call.q?.includes("mercadopago.com.co")) return { messageIds: ["shared-msg-1"] };
        return { messageIds: [] };
      },
    });

    const result = await pullForUser(
      userA,
      { gateways: ["mercado_pago"] },
      { getClient: async () => authed },
    );
    expect(result.pulled).toBe(1);

    const rowsA = await db
      .select({ msgId: emailReceipts.gmailMsgId })
      .from(emailReceipts)
      .where(and(eq(emailReceipts.userId, userA), eq(emailReceipts.gmailMsgId, "shared-msg-1")));
    expect(rowsA).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // invalid_grant mid-pull → mark connection revoked, return error, don't throw.
  // -------------------------------------------------------------------------

  it("marks connection revoked on invalid_grant during message.get", async () => {
    const connId = await seedActiveConnection(userA);
    const { authed } = fakeAuthed({
      userId: userA,
      connectionId: connId,
      gmailEmail: `${TAG}-${userA}@example.com`,
      onList: (call) => {
        if (call.q?.includes("mercadopago.com.co")) return { messageIds: ["mp-msg-boom"] };
        return { messageIds: [] };
      },
      onGet: () => {
        throw Object.assign(new Error("Token has been expired. invalid_grant"), {
          response: { data: { error: "invalid_grant" } },
        });
      },
    });

    const result = await pullForUser(
      userA,
      { gateways: ["mercado_pago"] },
      { getClient: async () => authed },
    );

    expect(result.connectionId).toBe(connId);
    expect(result.pulled).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe("invalid_grant");

    const [row] = await db
      .select({ status: gmailConnections.status, reason: gmailConnections.statusReason })
      .from(gmailConnections)
      .where(eq(gmailConnections.id, connId));
    expect(row.status).toBe("revoked");
    expect(row.reason).toContain("invalid_grant");
  });

  // -------------------------------------------------------------------------
  // Watermark semantics.
  // -------------------------------------------------------------------------

  it("does not advance last_pull_at when there are per-message errors", async () => {
    const connId = await seedActiveConnection(userA);
    const { authed } = fakeAuthed({
      userId: userA,
      connectionId: connId,
      gmailEmail: `${TAG}-${userA}@example.com`,
      onList: (call) => {
        if (call.q?.includes("mercadopago.com.co")) return { messageIds: ["mp-empty"] };
        return { messageIds: [] };
      },
      onGet: () => {
        // No payload → extractBody returns empty string → "no text/html or
        // text/plain body found" error detail, but pull keeps running.
        return { data: { id: "mp-empty", payload: {} } };
      },
    });

    const now = new Date("2026-04-24T12:00:00Z");
    const result = await pullForUser(
      userA,
      { gateways: ["mercado_pago"] },
      { getClient: async () => authed, now: () => now },
    );
    expect(result.pulled).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);

    const [conn] = await db
      .select({ lastPullAt: gmailConnections.lastPullAt })
      .from(gmailConnections)
      .where(eq(gmailConnections.id, connId));
    expect(conn.lastPullAt).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Per-gateway pull cursors (#511). The since-date comes from the gateway's
  // own cursor row, not from the connection's shared last_pull_at.
  // -------------------------------------------------------------------------

  it("advances the per-gateway cursor on a clean pull and upserts (not duplicates) on the next", async () => {
    const connId = await seedActiveConnection(userA);
    const { authed } = fakeAuthed({
      userId: userA,
      connectionId: connId,
      gmailEmail: `${TAG}-${userA}@example.com`,
      onList: (call) =>
        call.q?.includes("mercadopago.com.co") ? { messageIds: ["mp-c-1"] } : { messageIds: [] },
    });

    const now1 = new Date("2026-04-24T12:00:00Z");
    await pullForUser(
      userA,
      { gateways: ["mercado_pago"] },
      { getClient: async () => authed, now: () => now1 },
    );

    let rows = await db
      .select()
      .from(gmailPullCursors)
      .where(eq(gmailPullCursors.connectionId, connId));
    expect(rows).toHaveLength(1);
    expect(rows[0].gateway).toBe("mercado_pago");
    expect(rows[0].userId).toBe(userA);
    expect(rows[0].lastPullAt?.getTime()).toBe(now1.getTime());

    // Second pull: the (connection_id, gateway) unique index is PARTIAL
    // (WHERE deleted_at IS NULL), so the ON CONFLICT needs targetWhere — a
    // bare target fails at runtime (engram: gotchas/drizzle-on-conflict-
    // partial-index). This exercises that path: UPDATE, not a second row.
    const now2 = new Date("2026-04-24T13:00:00Z");
    await pullForUser(
      userA,
      { gateways: ["mercado_pago"] },
      { getClient: async () => authed, now: () => now2 },
    );
    rows = await db
      .select()
      .from(gmailPullCursors)
      .where(eq(gmailPullCursors.connectionId, connId));
    expect(rows).toHaveLength(1);
    expect(rows[0].lastPullAt?.getTime()).toBe(now2.getTime());
  });

  it("bootstraps a gateway without a cursor row from bootstrapSinceDate, not the connection watermark", async () => {
    // The connection's legacy last_pull_at is deliberately set: if the pull
    // (wrongly) still read it, the q would carry after:2026-04-20 instead of
    // the bootstrap window.
    const connId = await seedActiveConnection(userA, {
      lastPullAt: new Date("2026-04-20T00:00:00Z"),
    });
    const bootstrap = new Date("2026-03-01T00:00:00Z");
    await db
      .update(gmailConnections)
      .set({ bootstrapSinceDate: bootstrap })
      .where(eq(gmailConnections.id, connId));
    const { authed, listCalls } = fakeAuthed({
      userId: userA,
      connectionId: connId,
      gmailEmail: `${TAG}-${userA}@example.com`,
      onList: () => ({ messageIds: [] }),
    });

    const now = new Date("2026-04-24T12:00:00Z");
    await pullForUser(
      userA,
      { gateways: ["mercado_pago"] },
      { getClient: async () => authed, now: () => now },
    );

    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].q).toContain("mercadopago.com.co");
    expect(afterSecondsOf(listCalls[0].q)).toBe(Math.floor(bootstrap.getTime() / 1000));

    // And the successful (if empty) pull creates the cursor row: the next
    // tick resumes from the watermark instead of re-bootstrapping.
    const [cursor] = await db
      .select({ lastPullAt: gmailPullCursors.lastPullAt })
      .from(gmailPullCursors)
      .where(eq(gmailPullCursors.connectionId, connId));
    expect(cursor.lastPullAt?.getTime()).toBe(now.getTime());
  });

  it("uses the gateway cursor's watermark (with 30-min overlap) when a cursor row exists", async () => {
    const connId = await seedActiveConnection(userA, {
      lastPullAt: new Date("2026-04-20T00:00:00Z"),
    });
    const cursorT = new Date("2026-04-23T10:00:00Z");
    await seedPullCursor(userA, connId, "mercado_pago", cursorT);
    const { authed, listCalls } = fakeAuthed({
      userId: userA,
      connectionId: connId,
      gmailEmail: `${TAG}-${userA}@example.com`,
      onList: () => ({ messageIds: [] }),
    });

    await pullForUser(
      userA,
      { gateways: ["mercado_pago"] },
      { getClient: async () => authed, now: () => new Date("2026-04-24T12:00:00Z") },
    );

    expect(listCalls).toHaveLength(1);
    // WATERMARK_OVERLAP_SECONDS = 30 min.
    expect(afterSecondsOf(listCalls[0].q)).toBe(
      Math.floor((cursorT.getTime() - 30 * 60 * 1000) / 1000),
    );
  });

  it("sinceDays overrides the gateway cursor, and the cursor still advances after", async () => {
    const connId = await seedActiveConnection(userA);
    await seedPullCursor(userA, connId, "mercado_pago", new Date("2026-04-23T10:00:00Z"));
    const { authed, listCalls } = fakeAuthed({
      userId: userA,
      connectionId: connId,
      gmailEmail: `${TAG}-${userA}@example.com`,
      onList: () => ({ messageIds: [] }),
    });

    const now = new Date("2026-04-24T12:00:00Z");
    await pullForUser(
      userA,
      { gateways: ["mercado_pago"], sinceDays: 2 },
      { getClient: async () => authed, now: () => now },
    );

    expect(listCalls).toHaveLength(1);
    expect(afterSecondsOf(listCalls[0].q)).toBe(
      Math.floor((now.getTime() - 2 * 86_400_000) / 1000),
    );

    const [cursor] = await db
      .select({ lastPullAt: gmailPullCursors.lastPullAt })
      .from(gmailPullCursors)
      .where(eq(gmailPullCursors.connectionId, connId));
    expect(cursor.lastPullAt?.getTime()).toBe(now.getTime());
  });

  it("a failing gateway does not hold other gateways' cursors back", async () => {
    const connId = await seedActiveConnection(userA);
    const { authed } = fakeAuthed({
      userId: userA,
      connectionId: connId,
      gmailEmail: `${TAG}-${userA}@example.com`,
      onList: (call) => {
        if (call.q?.includes("mercadopago.com.co")) return { messageIds: ["mp-err-1"] };
        if (call.q?.includes("payu.com") || call.q?.includes("payulatam.com")) {
          return { messageIds: ["payu-ok-1"] };
        }
        return { messageIds: [] };
      },
      onGet: (call) => {
        // Plain Error → no code → not retryable → surfaces immediately.
        if (call.id === "mp-err-1") throw new Error("boom");
        return fakeMessage(call.id, "<html><body>x</body></html>");
      },
    });

    const now = new Date("2026-04-24T12:00:00Z");
    const result = await pullForUser(
      userA,
      { gateways: ["mercado_pago", "payu"] },
      { getClient: async () => authed, now: () => now },
    );
    expect(result.errors.length).toBeGreaterThan(0);

    const rows = await db
      .select()
      .from(gmailPullCursors)
      .where(eq(gmailPullCursors.connectionId, connId));
    // mercado_pago failed → no cursor. payu succeeded → advanced. Under the
    // old per-connection watermark, payu's progress would have been lost.
    expect(rows).toHaveLength(1);
    expect(rows[0].gateway).toBe("payu");
    expect(rows[0].lastPullAt?.getTime()).toBe(now.getTime());
  });

  it("historical pulls (preserveCursor) leave the gateway cursors untouched", async () => {
    const connId = await seedActiveConnection(userA);
    const since = new Date("2026-01-01T00:00:00Z");
    const until = new Date("2026-02-01T00:00:00Z");
    const expectedQ = jetsmartHistoricalQuery(since, until);
    const { authed } = fakeAuthed({
      userId: userA,
      connectionId: connId,
      gmailEmail: `${TAG}-${userA}@example.com`,
      onList: (call) => (call.q === expectedQ ? { messageIds: ["js-hist-2"] } : { messageIds: [] }),
    });

    const result = await pullForUser(
      userA,
      { senders: ["jetsmart.com"], overrideSince: since, until, preserveCursor: true },
      { getClient: async () => authed, now: () => new Date("2026-09-09T16:00:00Z") },
    );
    expect(result.pulled).toBe(1);
    expect(result.errors).toHaveLength(0);

    const rows = await db
      .select()
      .from(gmailPullCursors)
      .where(eq(gmailPullCursors.connectionId, connId));
    expect(rows).toHaveLength(0);
  });

  it("cursors are per-connection: two users' pulls coexist and a connection delete cascades", async () => {
    const connA = await seedActiveConnection(userA);
    const connB = await seedActiveConnection(userB);
    const fakeA = fakeAuthed({
      userId: userA,
      connectionId: connA,
      gmailEmail: `${TAG}-${userA}@example.com`,
      onList: () => ({ messageIds: ["shared-a-1"] }),
    });
    const fakeB = fakeAuthed({
      userId: userB,
      connectionId: connB,
      gmailEmail: `${TAG}-${userB}@example.com`,
      onList: () => ({ messageIds: ["shared-b-1"] }),
    });

    await pullForUser(
      userA,
      { gateways: ["mercado_pago"] },
      { getClient: async () => fakeA.authed },
    );
    await pullForUser(
      userB,
      { gateways: ["mercado_pago"] },
      { getClient: async () => fakeB.authed },
    );

    const rows = await db
      .select()
      .from(gmailPullCursors)
      .where(inArray(gmailPullCursors.connectionId, [connA, connB]))
      .orderBy(gmailPullCursors.id);
    // Both users pulled the same gateway — the unique index is per-connection,
    // so both rows coexist, each scoped to its own user_id.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.gateway)).toEqual(["mercado_pago", "mercado_pago"]);
    expect(rows.map((r) => r.userId).sort()).toEqual([userA, userB].sort());
    expect(rows.map((r) => r.connectionId).sort()).toEqual([connA, connB].sort());

    // Deleting a connection cascades to its cursors — and only its cursors.
    await db.delete(gmailConnections).where(eq(gmailConnections.id, connA));
    const after = await db
      .select()
      .from(gmailPullCursors)
      .where(inArray(gmailPullCursors.connectionId, [connA, connB]));
    expect(after).toHaveLength(1);
    expect(after[0].connectionId).toBe(connB);
    expect(after[0].userId).toBe(userB);
  });

  // -------------------------------------------------------------------------
  // 429 retry with backoff — exponential, honors Retry-After.
  // -------------------------------------------------------------------------

  it("retries on 429 with Retry-After and eventually succeeds", async () => {
    const connId = await seedActiveConnection(userA);
    let listAttempts = 0;
    const { authed } = fakeAuthed({
      userId: userA,
      connectionId: connId,
      gmailEmail: `${TAG}-${userA}@example.com`,
      onList: (call) => {
        if (!call.q?.includes("mercadopago.com.co")) return { messageIds: [] };
        listAttempts++;
        if (listAttempts === 1) {
          const err = new Error("Rate limit exceeded") as Error & {
            code: number;
            response: { status: number; headers: Record<string, string> };
          };
          err.code = 429;
          err.response = { status: 429, headers: { "retry-after": "1" } };
          throw err;
        }
        return { messageIds: ["mp-msg-retry"] };
      },
    });

    const sleeps: number[] = [];
    const result = await pullForUser(
      userA,
      { gateways: ["mercado_pago"] },
      {
        getClient: async () => authed,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(result.pulled).toBe(1);
    expect(listAttempts).toBe(2);
    expect(sleeps).toEqual([1000]);
  });

  it("persists Gmail internalDate as emailReceivedAt (#545)", async () => {
    const connectionId = await seedActiveConnection(userA);
    const messageEpochMs = Date.UTC(2026, 3, 15, 14, 30, 0); // 2026-04-15 14:30 UTC
    const { authed } = fakeAuthed({
      userId: userA,
      connectionId,
      gmailEmail: `${TAG}-${userA}@example.com`,
      onList: () => ({ messageIds: ["msg-with-date"] }),
      onGet: () =>
        fakeMessage("msg-with-date", "<html><body>codebranch sample</body></html>", {
          internalDate: String(messageEpochMs),
        }),
    });
    const result = await pullForUser(
      userA,
      { gateways: ["arq"] },
      { getClient: async () => authed },
    );
    expect(result.pulled).toBe(1);
    const [row] = await db
      .select({
        emailReceivedAt: emailReceipts.emailReceivedAt,
      })
      .from(emailReceipts)
      .where(and(eq(emailReceipts.userId, userA), eq(emailReceipts.gmailMsgId, "msg-with-date")));
    expect(row).toBeDefined();
    expect(row.emailReceivedAt?.getTime()).toBe(messageEpochMs);
  });

  it("leaves emailReceivedAt null when Gmail omits internalDate (#545)", async () => {
    const connectionId = await seedActiveConnection(userA);
    const { authed } = fakeAuthed({
      userId: userA,
      connectionId,
      gmailEmail: `${TAG}-${userA}@example.com`,
      onList: () => ({ messageIds: ["msg-no-date"] }),
      onGet: () => fakeMessage("msg-no-date", "<html><body>x</body></html>"),
    });
    const result = await pullForUser(
      userA,
      { gateways: ["arq"] },
      { getClient: async () => authed },
    );
    expect(result.pulled).toBe(1);
    const [row] = await db
      .select({
        emailReceivedAt: emailReceipts.emailReceivedAt,
      })
      .from(emailReceipts)
      .where(and(eq(emailReceipts.userId, userA), eq(emailReceipts.gmailMsgId, "msg-no-date")));
    expect(row.emailReceivedAt).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Historical sender fetch (#849) — explicit window, cursor frozen.
  // -------------------------------------------------------------------------

  it("does not advance last_pull_at when preserveCursor is set", async () => {
    const frozen = new Date("2026-09-01T12:00:00Z");
    const connId = await seedActiveConnection(userA, { lastPullAt: frozen });
    const since = new Date("2026-01-01T00:00:00Z");
    const until = new Date("2026-02-01T00:00:00Z");
    const expectedQ = jetsmartHistoricalQuery(since, until);
    const { authed } = fakeAuthed({
      userId: userA,
      connectionId: connId,
      gmailEmail: `${TAG}-${userA}@example.com`,
      onList: (call) => {
        if (call.q === expectedQ) return { messageIds: ["js-hist-1"] };
        return { messageIds: [] };
      },
    });

    const now = new Date("2026-09-09T16:00:00Z");
    const result = await pullForUser(
      userA,
      {
        senders: ["jetsmart.com"],
        overrideSince: since,
        until,
        preserveCursor: true,
      },
      { getClient: async () => authed, now: () => now },
    );
    expect(result.pulled).toBe(1);
    expect(result.errors).toHaveLength(0);

    const [conn] = await db
      .select({ lastPullAt: gmailConnections.lastPullAt })
      .from(gmailConnections)
      .where(eq(gmailConnections.id, connId));
    expect(conn.lastPullAt?.getTime()).toBe(frozen.getTime());
  });

  it("scopes the list query to the sender and the [since, until) window", async () => {
    const connId = await seedActiveConnection(userA);
    const { authed, listCalls } = fakeAuthed({
      userId: userA,
      connectionId: connId,
      gmailEmail: `${TAG}-${userA}@example.com`,
      onList: () => ({ messageIds: [] }),
    });

    const since = new Date("2026-01-01T00:00:00Z");
    const until = new Date("2026-02-01T00:00:00Z");
    await pullForUser(
      userA,
      {
        senders: ["mercadolibre.com"],
        overrideSince: since,
        until,
        preserveCursor: true,
      },
      { getClient: async () => authed },
    );

    expect(listCalls).toHaveLength(1);
    const q = listCalls[0].q ?? "";
    expect(q).toContain("from:(@mercadolibre.com)");
    expect(q).not.toContain("mercadopago.com");
    expect(q).not.toContain("mercadolibre.com.co");
    expect(q).toContain(`after:${Math.floor(since.getTime() / 1000)}`);
    expect(q).toContain(`before:${Math.floor(until.getTime() / 1000)}`);
  });

  it("is idempotent across an overlapping window without duplicating receipts", async () => {
    const frozen = new Date("2026-09-01T12:00:00Z");
    const connId = await seedActiveConnection(userA, { lastPullAt: frozen });
    const since = new Date("2026-01-01T00:00:00Z");
    const until = new Date("2026-02-01T00:00:00Z");
    const expectedQ = jetsmartHistoricalQuery(since, until);
    const { authed } = fakeAuthed({
      userId: userA,
      connectionId: connId,
      gmailEmail: `${TAG}-${userA}@example.com`,
      onList: (call) => {
        if (call.q === expectedQ) return { messageIds: ["js-hist-1"] };
        return { messageIds: [] };
      },
    });

    const opts: PullOpts = {
      senders: ["jetsmart.com"],
      overrideSince: since,
      until,
      preserveCursor: true,
    };

    const first = await pullForUser(userA, opts, { getClient: async () => authed });
    const second = await pullForUser(userA, opts, { getClient: async () => authed });
    expect(first.pulled).toBe(1);
    expect(second.pulled).toBe(0);
    expect(second.skipped).toBe(1);

    const rows = await db
      .select({ msgId: emailReceipts.gmailMsgId, gateway: emailReceipts.gateway })
      .from(emailReceipts)
      .where(eq(emailReceipts.userId, userA));
    expect(rows).toHaveLength(1);
    expect(rows[0].gateway).toBe("jetsmart");

    const [conn] = await db
      .select({ lastPullAt: gmailConnections.lastPullAt })
      .from(gmailConnections)
      .where(eq(gmailConnections.id, connId));
    expect(conn.lastPullAt?.getTime()).toBe(frozen.getTime());
  });

  it("surfaces a list error instead of silently truncating when the page cap is hit", async () => {
    const connId = await seedActiveConnection(userA);
    const { authed } = fakeAuthed({
      userId: userA,
      connectionId: connId,
      gmailEmail: `${TAG}-${userA}@example.com`,
      onList: () => ({ messageIds: ["js-page-1"], nextPageToken: "more" }),
    });

    const result = await pullForUser(
      userA,
      {
        senders: ["jetsmart.com"],
        overrideSince: new Date("2026-01-01T00:00:00Z"),
        until: new Date("2026-02-01T00:00:00Z"),
        preserveCursor: true,
        maxPages: 1,
      },
      { getClient: async () => authed },
    );
    expect(result.pulled).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].phase).toBe("list");
    expect(result.errors[0].message).toMatch(/hit page cap/);
  });

  it("refuses senders/until without preserveCursor and does not advance last_pull_at", async () => {
    const frozen = new Date("2026-09-01T12:00:00Z");
    const connId = await seedActiveConnection(userA, { lastPullAt: frozen });
    let getClientCalls = 0;

    await expect(
      pullForUser(
        userA,
        // Intentional bypass: this is the shape a future JSON/BullMQ caller
        // would pass if they forgot the flag. The type system rejects the
        // object literal; runtime must still refuse.
        {
          senders: ["jetsmart.com"],
          overrideSince: new Date("2026-01-01T00:00:00Z"),
          until: new Date("2026-02-01T00:00:00Z"),
        } as PullOpts,
        {
          getClient: async () => {
            getClientCalls += 1;
            throw new Error("getClient must not run when senders/until lack preserveCursor");
          },
        },
      ),
    ).rejects.toThrow(/preserveCursor: true/);
    expect(getClientCalls).toBe(0);

    const [conn] = await db
      .select({ lastPullAt: gmailConnections.lastPullAt })
      .from(gmailConnections)
      .where(eq(gmailConnections.id, connId));
    expect(conn.lastPullAt?.getTime()).toBe(frozen.getTime());
  });
});

// =============================================================================
// computeSinceDate — unit tests for the since-date fallback chain (#498)
// =============================================================================

describe("computeSinceDate fallback chain", () => {
  const NOW = new Date("2026-04-25T12:00:00Z");
  const LAST_PULL = new Date("2026-04-24T10:00:00Z");
  const BOOTSTRAP = new Date("2026-01-15T00:00:00Z");
  const OVERRIDE = new Date("2025-12-01T00:00:00Z");

  it("overrideSince wins over everything (re-bootstrap action)", () => {
    const result = computeSinceDate({
      now: NOW,
      lastPullAt: LAST_PULL,
      bootstrapSinceDate: BOOTSTRAP,
      sinceDays: 7,
      overrideSince: OVERRIDE,
    });
    expect(result).toEqual(OVERRIDE);
  });

  it("sinceDays wins when overrideSince is absent", () => {
    const result = computeSinceDate({
      now: NOW,
      lastPullAt: LAST_PULL,
      bootstrapSinceDate: BOOTSTRAP,
      sinceDays: 7,
    });
    // 7 days before NOW
    expect(result).toEqual(new Date(NOW.getTime() - 7 * 86_400_000));
  });

  it("lastPullAt wins over bootstrapSinceDate (normal watermark with 30-min overlap)", () => {
    const result = computeSinceDate({
      now: NOW,
      lastPullAt: LAST_PULL,
      bootstrapSinceDate: BOOTSTRAP,
    });
    const WATERMARK_OVERLAP_SECONDS = 30 * 60;
    expect(result).toEqual(new Date(LAST_PULL.getTime() - WATERMARK_OVERLAP_SECONDS * 1000));
  });

  it("bootstrapSinceDate used when lastPullAt is null", () => {
    const result = computeSinceDate({
      now: NOW,
      lastPullAt: null,
      bootstrapSinceDate: BOOTSTRAP,
    });
    expect(result).toEqual(BOOTSTRAP);
  });

  it("falls back to Jan 1 of current year when both lastPullAt and bootstrapSinceDate are null", () => {
    const result = computeSinceDate({
      now: NOW,
      lastPullAt: null,
      bootstrapSinceDate: null,
    });
    const jan1 = new Date(NOW.getFullYear(), 0, 1);
    expect(result).toEqual(jan1);
  });
});
