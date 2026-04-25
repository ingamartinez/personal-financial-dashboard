import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, emailReceipts, gmailConnections, transactions, users } from "@/lib/db/schema";
import { gmailCipher } from "@/lib/crypto/gmail-cipher";

// ── Session mock ──────────────────────────────────────────────────────────────
// Shared state so individual tests can swap the active user.
const { mockUser } = vi.hoisted(() => ({
  mockUser: {
    value: null as null | {
      id: number;
      email: string;
      name: string;
      role: "user" | "admin";
      active: boolean;
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({
  getSessionUserOrNull: vi.fn(() => Promise.resolve(mockUser.value)),
}));

// Must import the route AFTER mocking session
const { POST } = await import("./route");

// ── Constants ─────────────────────────────────────────────────────────────────
const TAG = "VITEST_DISAMBIG_";
const GMAIL_KEY_ENV = "GMAIL_TOKEN_ENCRYPTION_KEY";
const ORIGINAL_KEY = process.env[GMAIL_KEY_ENV];

let userA: number;
let userB: number;
let accountA: number;
let accountB: number;
let connA: number;
let connB: number;

// ── Helpers ───────────────────────────────────────────────────────────────────
async function cleanup() {
  await db.execute(sql`DELETE FROM email_receipts WHERE user_id IN (${userA}, ${userB})`);
  await db.execute(sql`DELETE FROM transactions WHERE account_id IN (${accountA}, ${accountB})`);
}

async function createUser(suffix: string) {
  const [row] = await db
    .insert(users)
    .values({ email: `${TAG}${suffix}@test.local`, name: `${TAG}${suffix}` })
    .returning({ id: users.id });
  return row.id;
}

async function createAccount(userId: number, suffix: string) {
  const [row] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${TAG}${suffix}`,
      institution: "Test",
      type: "savings",
      currency: "COP",
    })
    .returning({ id: accounts.id });
  return row.id;
}

async function createConnection(userId: number) {
  const [row] = await db
    .insert(gmailConnections)
    .values({
      userId,
      gmailEmail: `${TAG}${userId}@example.com`,
      accessTokenEnc: gmailCipher.encrypt("dummy-access"),
      refreshTokenEnc: gmailCipher.encrypt("dummy-refresh"),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "active",
    })
    .returning({ id: gmailConnections.id });
  return row.id;
}

async function createTx(userId: number, accountId: number) {
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      accountId,
      occurredAt: new Date("2026-04-01T10:00:00Z"),
      amountCents: BigInt(-50000),
      currency: "COP",
      descriptionRaw: "MERCHANT TEST",
      classificationMethod: "unclassified",
      source: "sms",
    })
    .returning({ id: transactions.id });
  return row.id;
}

async function createAmbiguousReceipt(opts: {
  userId: number;
  connId: number;
  candidates: number[];
  merchant?: string;
}) {
  const [row] = await db
    .insert(emailReceipts)
    .values({
      userId: opts.userId,
      gmailConnectionId: opts.connId,
      gmailMsgId: `${TAG}${Date.now()}-${Math.random()}`,
      gateway: "mercado_pago",
      amountCents: BigInt(50000),
      occurredAt: new Date("2026-04-01T10:30:00Z"),
      merchant: opts.merchant ?? "TestMerchant",
      currency: "COP",
      rawHtml: "<html>test</html>",
      matchStatus: "ambiguous",
      matchCandidates: opts.candidates,
    })
    .returning({ id: emailReceipts.id });
  return row.id;
}

async function getReceiptState(id: number) {
  const [row] = await db
    .select({
      matchStatus: emailReceipts.matchStatus,
      matchCandidates: emailReceipts.matchCandidates,
    })
    .from(emailReceipts)
    .where(eq(emailReceipts.id, id));
  return row;
}

async function getTxState(id: number) {
  const [row] = await db
    .select({
      enrichedMerchant: transactions.enrichedMerchant,
      enrichmentSource: transactions.enrichmentSource,
    })
    .from(transactions)
    .where(eq(transactions.id, id));
  return row;
}

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/integrations/gmail/disambiguate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
beforeAll(async () => {
  process.env[GMAIL_KEY_ENV] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  userA = await createUser("A");
  userB = await createUser("B");
  accountA = await createAccount(userA, "A");
  accountB = await createAccount(userB, "B");
  connA = await createConnection(userA);
  connB = await createConnection(userB);
});

afterEach(cleanup);

afterAll(async () => {
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id IN (${userA}, ${userB})`);
  await db.execute(sql`DELETE FROM accounts WHERE id IN (${accountA}, ${accountB})`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`);
  mockUser.value = null;
  if (ORIGINAL_KEY === undefined) delete process.env[GMAIL_KEY_ENV];
  else process.env[GMAIL_KEY_ENV] = ORIGINAL_KEY;
});

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("POST /api/integrations/gmail/disambiguate — auth", () => {
  it("returns 401 when not authenticated", async () => {
    mockUser.value = null;
    const res = await POST(makeRequest({ decision: "reject", transactionId: 1 }));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/integrations/gmail/disambiguate — confirm", () => {
  it("enriches the tx and marks winning receipt as matched", async () => {
    mockUser.value = {
      id: userA,
      email: `${TAG}A@test.local`,
      name: TAG,
      role: "user",
      active: true,
    };

    const txId = await createTx(userA, accountA);
    const receiptId = await createAmbiguousReceipt({
      userId: userA,
      connId: connA,
      candidates: [txId],
      merchant: "Rappi Merchant",
    });

    const res = await POST(makeRequest({ decision: "confirm", transactionId: txId, receiptId }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);

    // TX should be enriched
    const txState = await getTxState(txId);
    expect(txState.enrichedMerchant).toBe("Rappi Merchant");
    expect(txState.enrichmentSource).toBe("gmail");

    // Winning receipt should be matched
    const receiptState = await getReceiptState(receiptId);
    expect(receiptState.matchStatus).toBe("matched");
  });

  it("marks losing candidate receipts as unmatched after confirm", async () => {
    mockUser.value = {
      id: userA,
      email: `${TAG}A@test.local`,
      name: TAG,
      role: "user",
      active: true,
    };

    const txId = await createTx(userA, accountA);
    const winnerReceiptId = await createAmbiguousReceipt({
      userId: userA,
      connId: connA,
      candidates: [txId],
      merchant: "Winner",
    });
    const loserReceiptId = await createAmbiguousReceipt({
      userId: userA,
      connId: connA,
      candidates: [txId],
      merchant: "Loser",
    });

    const res = await POST(
      makeRequest({ decision: "confirm", transactionId: txId, receiptId: winnerReceiptId }),
    );
    expect(res.status).toBe(200);

    const loserState = await getReceiptState(loserReceiptId);
    expect(loserState.matchStatus).toBe("unmatched");
  });

  it("returns 404 when receiptId belongs to a different user (cross-tenant reject)", async () => {
    mockUser.value = {
      id: userA,
      email: `${TAG}A@test.local`,
      name: TAG,
      role: "user",
      active: true,
    };

    const txIdA = await createTx(userA, accountA);
    const txIdB = await createTx(userB, accountB);
    const receiptIdB = await createAmbiguousReceipt({
      userId: userB,
      connId: connB,
      candidates: [txIdB],
    });

    // UserA tries to confirm userB's receipt against userA's tx
    const res = await POST(
      makeRequest({ decision: "confirm", transactionId: txIdA, receiptId: receiptIdB }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when transactionId belongs to a different user", async () => {
    mockUser.value = {
      id: userA,
      email: `${TAG}A@test.local`,
      name: TAG,
      role: "user",
      active: true,
    };

    const txIdB = await createTx(userB, accountB);
    const receiptIdA = await createAmbiguousReceipt({
      userId: userA,
      connId: connA,
      candidates: [txIdB],
    });

    // UserA tries to enrich userB's tx with userA's receipt
    const res = await POST(
      makeRequest({ decision: "confirm", transactionId: txIdB, receiptId: receiptIdA }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 on invalid body", async () => {
    mockUser.value = {
      id: userA,
      email: `${TAG}A@test.local`,
      name: TAG,
      role: "user",
      active: true,
    };
    const res = await POST(makeRequest({ decision: "confirm" })); // missing transactionId + receiptId
    expect(res.status).toBe(400);
  });
});

describe("POST /api/integrations/gmail/disambiguate — reject", () => {
  it("removes transactionId from match_candidates and flips to unmatched when empty", async () => {
    mockUser.value = {
      id: userA,
      email: `${TAG}A@test.local`,
      name: TAG,
      role: "user",
      active: true,
    };

    const txId = await createTx(userA, accountA);
    const receiptId = await createAmbiguousReceipt({
      userId: userA,
      connId: connA,
      candidates: [txId],
    });

    const res = await POST(makeRequest({ decision: "reject", transactionId: txId }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);

    const state = await getReceiptState(receiptId);
    expect(state.matchStatus).toBe("unmatched");
    expect(state.matchCandidates).toEqual([]);
  });

  it("removes only this txId from candidates when other candidates remain", async () => {
    mockUser.value = {
      id: userA,
      email: `${TAG}A@test.local`,
      name: TAG,
      role: "user",
      active: true,
    };

    const tx1 = await createTx(userA, accountA);
    const tx2 = await createTx(userA, accountA);
    const receiptId = await createAmbiguousReceipt({
      userId: userA,
      connId: connA,
      candidates: [tx1, tx2],
    });

    // Reject tx1 only
    const res = await POST(makeRequest({ decision: "reject", transactionId: tx1 }));
    expect(res.status).toBe(200);

    const state = await getReceiptState(receiptId);
    // Still ambiguous because tx2 remains
    expect(state.matchStatus).toBe("ambiguous");
    expect(state.matchCandidates).toEqual([tx2]);
  });

  it("does NOT affect receipts from a different user", async () => {
    mockUser.value = {
      id: userA,
      email: `${TAG}A@test.local`,
      name: TAG,
      role: "user",
      active: true,
    };

    const txIdA = await createTx(userA, accountA);
    const txIdB = await createTx(userB, accountB);
    const receiptIdB = await createAmbiguousReceipt({
      userId: userB,
      connId: connB,
      candidates: [txIdB],
    });

    // UserA rejects what happens to be userB's tx_id (cross-tenant attempt)
    const res = await POST(makeRequest({ decision: "reject", transactionId: txIdA }));
    expect(res.status).toBe(200); // succeeds (nothing to do for userA)

    // UserB's receipt must be untouched
    const stateB = await getReceiptState(receiptIdB);
    expect(stateB.matchStatus).toBe("ambiguous");
  });
});
