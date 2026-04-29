import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  counterparties,
  counterpartyAliases,
  emailReceipts,
  gmailConnections,
  transactions,
  users,
} from "@/lib/db/schema";
import { ingestArqEmail } from "./email-arq";

const MARKER = "__email_arq_test";

let USER_A = 0;
let USER_B = 0;
let CONN_A = 0;
let CONN_B = 0;
let ARQ_ACCOUNT_A = 0;
let ARQ_ACCOUNT_B = 0;

async function cleanup() {
  await db.execute(sql`DELETE FROM counterparty_aliases WHERE user_id IN (${USER_A}, ${USER_B})`);
  await db.execute(sql`DELETE FROM counterparties WHERE user_id IN (${USER_A}, ${USER_B})`);
  await db.execute(sql`DELETE FROM email_receipts WHERE user_id IN (${USER_A}, ${USER_B})`);
  await db.execute(sql`DELETE FROM transactions WHERE user_id IN (${USER_A}, ${USER_B})`);
}

beforeAll(async () => {
  const [a] = await db
    .insert(users)
    .values({ email: `${MARKER}-a@test.local`, name: "A" })
    .returning({ id: users.id });
  const [b] = await db
    .insert(users)
    .values({ email: `${MARKER}-b@test.local`, name: "B" })
    .returning({ id: users.id });
  USER_A = a.id;
  USER_B = b.id;

  // Gmail connections are required by the emailReceipts FK.
  const [connA] = await db
    .insert(gmailConnections)
    .values({
      userId: USER_A,
      gmailEmail: `${MARKER}-a@test.local`,
      accessTokenEnc: "dummy",
      refreshTokenEnc: "dummy",
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "active",
    })
    .returning({ id: gmailConnections.id });
  const [connB] = await db
    .insert(gmailConnections)
    .values({
      userId: USER_B,
      gmailEmail: `${MARKER}-b@test.local`,
      accessTokenEnc: "dummy",
      refreshTokenEnc: "dummy",
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "active",
    })
    .returning({ id: gmailConnections.id });
  CONN_A = connA.id;
  CONN_B = connB.id;

  // ARQ Ahorros account for each user (institution_slug='other', USD, last4s=['7073']).
  const [acctA] = await db
    .insert(accounts)
    .values({
      userId: USER_A,
      name: `${MARKER} ARQ Ahorros A`,
      institution: "ARQ",
      institutionSlug: "other",
      type: "savings",
      currency: "USD",
      metadata: { last4s: ["7073"] },
    })
    .returning({ id: accounts.id });
  const [acctB] = await db
    .insert(accounts)
    .values({
      userId: USER_B,
      name: `${MARKER} ARQ Ahorros B`,
      institution: "ARQ",
      institutionSlug: "other",
      type: "savings",
      currency: "USD",
      metadata: { last4s: ["7073"] },
    })
    .returning({ id: accounts.id });
  ARQ_ACCOUNT_A = acctA.id;
  ARQ_ACCOUNT_B = acctB.id;
});

beforeEach(cleanup);
afterEach(cleanup);

afterAll(async () => {
  await db.execute(sql`DELETE FROM accounts WHERE id IN (${ARQ_ACCOUNT_A}, ${ARQ_ACCOUNT_B})`);
  await db.execute(sql`DELETE FROM gmail_connections WHERE id IN (${CONN_A}, ${CONN_B})`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${USER_A}, ${USER_B})`);
});

// ---------------------------------------------------------------------------
// HTML fixture builders
// ---------------------------------------------------------------------------

/**
 * Minimal ARQ transfer_received HTML (titled template).
 * Produces: txKind='transfer_received', counterpartyName=name, amountUsdcCents=cents
 */
function buildReceivedHtml(name: string, amountUsd: string): string {
  return `<html>
    <head><title>You received ${amountUsd} USD from ${name}</title></head>
    <body>
      <p>We&apos;ve credited ${amountUsd} USDc to your balance.</p>
    </body>
  </html>`;
}

/**
 * Minimal ARQ transfer_sent HTML (titled template).
 * Produces: txKind='transfer_sent', counterpartyName=name, amountUsdcCents=cents
 */
function buildSentHtml(name: string, amountUsd: string): string {
  return `<html>
    <head><title>You sent ${amountUsd} USD to ${name}</title></head>
    <body>
      <p>We&apos;ve debited ${amountUsd} USDc from your balance.</p>
    </body>
  </html>`;
}

// ---------------------------------------------------------------------------
// Receipt seed helper
// ---------------------------------------------------------------------------

async function seedReceipt(
  userId: number,
  connId: number,
  msgId: string,
  rawHtml: string,
): Promise<number> {
  const [row] = await db
    .insert(emailReceipts)
    .values({
      userId,
      gmailConnectionId: connId,
      gmailMsgId: msgId,
      gateway: "arq",
      rawHtml,
    })
    .returning({ id: emailReceipts.id });
  return row.id;
}

const NOW = new Date("2026-04-01T10:00:00Z");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ingestArqEmail — counterparty linking", () => {
  it("happy path — new ingest links counterparty (and normalizes the alias)", async () => {
    // Mixed case input: proves normalizeName uppercases the alias value
    // even though the parser preserves casing in counterpartyName.
    // (The parser already collapses internal whitespace via /\s+/g, " ").
    const html = buildReceivedHtml("Codebranch Llc", "2,180");
    const receiptId = await seedReceipt(USER_A, CONN_A, `msg-${MARKER}-1`, html);

    const result = await ingestArqEmail(USER_A, receiptId, html, NOW);

    expect(result.status).toBe("inserted");

    // Transaction must have counterparty_id set.
    const [tx] = await db
      .select({ counterpartyId: transactions.counterpartyId })
      .from(transactions)
      .where(eq(transactions.userId, USER_A));
    expect(tx.counterpartyId).not.toBeNull();

    // Display name preserves the original (post-parse) casing.
    const [cp] = await db
      .select({ displayName: counterparties.displayName })
      .from(counterparties)
      .where(eq(counterparties.userId, USER_A));
    expect(cp.displayName).toBe("Codebranch Llc");

    // Alias VALUE is the uppercased normalized form — proves normalizeName ran.
    const [alias] = await db
      .select({ kind: counterpartyAliases.kind, value: counterpartyAliases.value })
      .from(counterpartyAliases)
      .where(eq(counterpartyAliases.userId, USER_A));
    expect(alias.kind).toBe("name");
    expect(alias.value).toBe("CODEBRANCH LLC");
  });

  it("idempotency — same receipt twice returns duplicated, first call still linked counterparty", async () => {
    const html = buildReceivedHtml("CODEBRANCH LLC", "2,180");
    const receiptId = await seedReceipt(USER_A, CONN_A, `msg-${MARKER}-2`, html);

    const result1 = await ingestArqEmail(USER_A, receiptId, html, NOW);
    expect(result1.status).toBe("inserted");

    // Confirm the FIRST call actually linked the counterparty — without this,
    // the test would still pass even if resolveCounterpartyByKey silently
    // returned null on the first call.
    const [tx] = await db
      .select({ counterpartyId: transactions.counterpartyId })
      .from(transactions)
      .where(eq(transactions.userId, USER_A));
    expect(tx.counterpartyId).not.toBeNull();

    const result2 = await ingestArqEmail(USER_A, receiptId, html, NOW);

    expect(result2.status).toBe("duplicated");

    // Still exactly one counterparty and one alias.
    const cpRows = await db
      .select({ id: counterparties.id })
      .from(counterparties)
      .where(eq(counterparties.userId, USER_A));
    expect(cpRows).toHaveLength(1);

    const aliasRows = await db
      .select({ id: counterpartyAliases.id })
      .from(counterpartyAliases)
      .where(eq(counterpartyAliases.userId, USER_A));
    expect(aliasRows).toHaveLength(1);
  });

  it("alias matching — different casing maps to the same counterparty", async () => {
    const html1 = buildReceivedHtml("CODEBRANCH LLC", "2,180");
    const html2 = buildReceivedHtml("Codebranch Llc", "500");

    const receipt1 = await seedReceipt(USER_A, CONN_A, `msg-${MARKER}-3a`, html1);
    const receipt2 = await seedReceipt(USER_A, CONN_A, `msg-${MARKER}-3b`, html2);

    const r1 = await ingestArqEmail(USER_A, receipt1, html1, NOW);
    const r2 = await ingestArqEmail(USER_A, receipt2, html2, NOW);

    expect(r1.status).toBe("inserted");
    expect(r2.status).toBe("inserted");

    // Both transactions share the same counterparty_id.
    const txRows = await db
      .select({ counterpartyId: transactions.counterpartyId })
      .from(transactions)
      .where(eq(transactions.userId, USER_A));
    expect(txRows).toHaveLength(2);
    expect(txRows[0].counterpartyId).not.toBeNull();
    expect(txRows[0].counterpartyId).toBe(txRows[1].counterpartyId);

    // Only one counterparty row and one alias row.
    const cpRows = await db
      .select({ id: counterparties.id })
      .from(counterparties)
      .where(eq(counterparties.userId, USER_A));
    expect(cpRows).toHaveLength(1);

    const aliasRows = await db
      .select({ id: counterpartyAliases.id })
      .from(counterpartyAliases)
      .where(eq(counterpartyAliases.userId, USER_A));
    expect(aliasRows).toHaveLength(1);
  });

  it("both directions — transfer_received and transfer_sent create distinct counterparties", async () => {
    const htmlReceived = buildReceivedHtml("CODEBRANCH LLC", "2,180");
    const htmlSent = buildSentHtml("GUSTAVO PEREZ", "100");

    const receipt1 = await seedReceipt(USER_A, CONN_A, `msg-${MARKER}-4a`, htmlReceived);
    const receipt2 = await seedReceipt(USER_A, CONN_A, `msg-${MARKER}-4b`, htmlSent);

    const r1 = await ingestArqEmail(USER_A, receipt1, htmlReceived, NOW);
    const r2 = await ingestArqEmail(USER_A, receipt2, htmlSent, new Date(NOW.getTime() + 1000));

    expect(r1.status).toBe("inserted");
    expect(r2.status).toBe("inserted");

    // Two distinct counterparties.
    const cpRows = await db
      .select({ displayName: counterparties.displayName })
      .from(counterparties)
      .where(eq(counterparties.userId, USER_A));
    expect(cpRows).toHaveLength(2);
    const names = cpRows.map((c) => c.displayName).sort();
    expect(names).toEqual(["CODEBRANCH LLC", "GUSTAVO PEREZ"]);

    // Both transactions have counterparty_id set and they differ.
    const txRows = await db
      .select({ counterpartyId: transactions.counterpartyId })
      .from(transactions)
      .where(eq(transactions.userId, USER_A));
    expect(txRows).toHaveLength(2);
    const ids = txRows.map((t) => t.counterpartyId);
    expect(ids[0]).not.toBeNull();
    expect(ids[1]).not.toBeNull();
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("tenant safety — counterparties are scoped per user", async () => {
    const htmlA = buildReceivedHtml("CODEBRANCH LLC", "2,180");
    const htmlB = buildReceivedHtml("CODEBRANCH LLC", "500");

    const receiptA = await seedReceipt(USER_A, CONN_A, `msg-${MARKER}-5a`, htmlA);
    const receiptB = await seedReceipt(USER_B, CONN_B, `msg-${MARKER}-5b`, htmlB);

    const rA = await ingestArqEmail(USER_A, receiptA, htmlA, NOW);
    const rB = await ingestArqEmail(USER_B, receiptB, htmlB, NOW);

    expect(rA.status).toBe("inserted");
    expect(rB.status).toBe("inserted");

    // Two distinct counterparty rows — one per user.
    const allCp = await db.execute<{ id: number; user_id: number }>(sql`
        SELECT id, user_id FROM counterparties
        WHERE user_id IN (${USER_A}, ${USER_B})
      `);
    expect(allCp).toHaveLength(2);
    const userIds = allCp.map((c) => c.user_id).sort();
    expect(userIds).toEqual([USER_A, USER_B].sort());

    // Each user's tx points only to their own counterparty.
    const [txA] = await db
      .select({ counterpartyId: transactions.counterpartyId, userId: transactions.userId })
      .from(transactions)
      .where(eq(transactions.userId, USER_A));
    const [txB] = await db
      .select({ counterpartyId: transactions.counterpartyId, userId: transactions.userId })
      .from(transactions)
      .where(eq(transactions.userId, USER_B));

    expect(txA.counterpartyId).not.toBeNull();
    expect(txB.counterpartyId).not.toBeNull();
    expect(txA.counterpartyId).not.toBe(txB.counterpartyId);
  });
});
