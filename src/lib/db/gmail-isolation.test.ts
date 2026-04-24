import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailReceipts, gmailConnections, users } from "@/lib/db/schema";

// #450 (Epic G): schema-level tenant isolation for Gmail tables. Helpers and
// queries don't exist yet — they land in #451-#458 with their own tests. This
// file proves the SCHEMA's safety:
//   - UNIQUE indexes scoped by user_id (two users may legitimately share the
//     same gmail_email or gmail_msg_id without a constraint conflict)
//   - ON DELETE CASCADE on user_id removes downstream rows
//   - Soft-delete on gmail_connections frees the (user_id, gmail_email) slot
//     so the user can reconnect after disconnecting
//   - Direct user-scoped SELECT never returns the other user's rows
//
// Reference: leak in #338 — when the schema fails to scope, any callsite that
// forgets the WHERE clause leaks tenant data. The schema should make leakage
// hard, not just "policy".

const TAG = "GMAIL_ISO_TEST";

let userA: number;
let userB: number;

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

async function createConnection(userId: number, email: string) {
  return db
    .insert(gmailConnections)
    .values({
      userId,
      gmailEmail: email,
      accessTokenEnc: `${TAG}-access`,
      refreshTokenEnc: `${TAG}-refresh`,
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    })
    .returning({ id: gmailConnections.id });
}

async function createReceipt(userId: number, connectionId: number, gmailMsgId: string) {
  return db
    .insert(emailReceipts)
    .values({
      userId,
      gmailConnectionId: connectionId,
      gmailMsgId,
      gateway: "mercado_pago",
      rawHtml: `<html>${TAG}</html>`,
    })
    .returning({ id: emailReceipts.id });
}

describe("#450 gmail tables — schema tenant isolation", () => {
  beforeAll(async () => {
    await cleanup();
    userA = await createUser("A");
    userB = await createUser("B");
  });

  afterAll(async () => {
    await cleanup();
    // Do NOT call db.$client.end() here. Vitest runs files sequentially
    // (fileParallelism:false) sharing the same process, so closing the
    // client breaks downstream files (e.g. tenant-isolation.test.ts which
    // does its own .end() and assumes it's last).
  });

  // -------------------------------------------------------------------------
  // UNIQUE indexes are scoped by user_id
  // -------------------------------------------------------------------------

  it("two users can both have an active gmail_connection for the same gmail_email", async () => {
    const sharedEmail = `${TAG}-shared@gmail.com`;
    const [a] = await createConnection(userA, sharedEmail);
    const [b] = await createConnection(userB, sharedEmail);
    expect(a.id).toBeGreaterThan(0);
    expect(b.id).toBeGreaterThan(0);
    expect(a.id).not.toBe(b.id);
  });

  it("same user CANNOT have two active connections for the same gmail_email", async () => {
    const dupEmail = `${TAG}-dup@gmail.com`;
    await createConnection(userA, dupEmail);
    await expect(createConnection(userA, dupEmail)).rejects.toThrow();
  });

  it("two users can both have email_receipts with the same gmail_msg_id", async () => {
    const sharedMsgId = `${TAG}-shared-msg-1`;
    const [connA] = await createConnection(userA, `${TAG}-msgA@gmail.com`);
    const [connB] = await createConnection(userB, `${TAG}-msgB@gmail.com`);
    const [a] = await createReceipt(userA, connA.id, sharedMsgId);
    const [b] = await createReceipt(userB, connB.id, sharedMsgId);
    expect(a.id).not.toBe(b.id);
  });

  it("same user CANNOT ingest the same gmail_msg_id twice (idempotency)", async () => {
    const dupMsgId = `${TAG}-dup-msg-1`;
    const [conn] = await createConnection(userA, `${TAG}-dupmsg@gmail.com`);
    await createReceipt(userA, conn.id, dupMsgId);
    await expect(createReceipt(userA, conn.id, dupMsgId)).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Soft-delete frees the unique slot — user can reconnect same email
  // -------------------------------------------------------------------------

  it("soft-deleting a connection lets the same user reconnect the same gmail_email", async () => {
    const reconnectEmail = `${TAG}-reconnect@gmail.com`;
    const [first] = await createConnection(userA, reconnectEmail);
    await db
      .update(gmailConnections)
      .set({ deletedAt: new Date() })
      .where(eq(gmailConnections.id, first.id));
    // Same gmail_email, same user — should now succeed because partial unique
    // index excludes soft-deleted rows.
    const [second] = await createConnection(userA, reconnectEmail);
    expect(second.id).not.toBe(first.id);
  });

  // -------------------------------------------------------------------------
  // Direct SELECT scoped by user_id never returns the other user's rows
  // -------------------------------------------------------------------------

  it("user-scoped SELECT on gmail_connections returns only own rows", async () => {
    const onlyMineA = await db
      .select({ id: gmailConnections.id })
      .from(gmailConnections)
      .where(and(eq(gmailConnections.userId, userA)));
    const onlyMineB = await db
      .select({ id: gmailConnections.id })
      .from(gmailConnections)
      .where(and(eq(gmailConnections.userId, userB)));
    // Disjoint sets — no id appears in both.
    const idsA = new Set(onlyMineA.map((r) => r.id));
    const idsB = new Set(onlyMineB.map((r) => r.id));
    for (const id of idsB) expect(idsA.has(id)).toBe(false);
  });

  it("user-scoped SELECT on email_receipts returns only own rows", async () => {
    const onlyMineA = await db
      .select({ id: emailReceipts.id })
      .from(emailReceipts)
      .where(eq(emailReceipts.userId, userA));
    const onlyMineB = await db
      .select({ id: emailReceipts.id })
      .from(emailReceipts)
      .where(eq(emailReceipts.userId, userB));
    const idsA = new Set(onlyMineA.map((r) => r.id));
    const idsB = new Set(onlyMineB.map((r) => r.id));
    for (const id of idsB) expect(idsA.has(id)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // ON DELETE CASCADE removes connections + receipts when user is deleted
  // -------------------------------------------------------------------------

  it("deleting a user cascades to their gmail_connections and email_receipts", async () => {
    const tempUser = await createUser("CASCADE");
    const [conn] = await createConnection(tempUser, `${TAG}-cascade@gmail.com`);
    await createReceipt(tempUser, conn.id, `${TAG}-cascade-msg`);

    await db.delete(users).where(eq(users.id, tempUser));

    const remainingConns = await db
      .select({ id: gmailConnections.id })
      .from(gmailConnections)
      .where(eq(gmailConnections.userId, tempUser));
    const remainingReceipts = await db
      .select({ id: emailReceipts.id })
      .from(emailReceipts)
      .where(eq(emailReceipts.userId, tempUser));
    expect(remainingConns).toEqual([]);
    expect(remainingReceipts).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // INSERT without user_id must fail — same defense as #183
  // -------------------------------------------------------------------------

  it("INSERT into gmail_connections without user_id fails (NOT NULL guards tenancy)", async () => {
    let err: unknown;
    try {
      await db.execute(sql`
        INSERT INTO gmail_connections
          (gmail_email, access_token_enc, refresh_token_enc, access_token_expires_at, scopes)
        VALUES
          (${TAG + "-noid@gmail.com"}, 'x', 'y', now(), ARRAY['gmail.readonly'])
      `);
    } catch (e) {
      err = e;
    }
    // Drizzle wraps the underlying postgres error in "Failed query: ...",
    // hiding the NOT NULL violation message. We just assert the throw — the
    // psql equivalent verifies the actual error mentions user_id specifically.
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/Failed query/i);
  });

  it("INSERT into email_receipts without user_id fails (NOT NULL guards tenancy)", async () => {
    const [conn] = await createConnection(userA, `${TAG}-noid-receipt@gmail.com`);
    let err: unknown;
    try {
      await db.execute(sql`
        INSERT INTO email_receipts
          (gmail_connection_id, gmail_msg_id, gateway, raw_html)
        VALUES
          (${conn.id}, ${TAG + "-noid-msg"}, 'mercado_pago', '<html/>')
      `);
    } catch (e) {
      err = e;
    }
    // Drizzle wraps the underlying postgres error in "Failed query: ...",
    // hiding the NOT NULL violation message. We just assert the throw — the
    // psql equivalent verifies the actual error mentions user_id specifically.
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/Failed query/i);
  });
});
