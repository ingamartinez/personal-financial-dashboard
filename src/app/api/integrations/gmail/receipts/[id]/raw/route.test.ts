import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, emailReceipts, gmailConnections, users } from "@/lib/db/schema";
import { gmailCipher } from "@/lib/crypto/gmail-cipher";

// ── Session mock ──────────────────────────────────────────────────────────────
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

const { GET } = await import("./route");

// ── Constants ─────────────────────────────────────────────────────────────────
const TAG = "VITEST_RAW_EMAIL_";
const GMAIL_KEY_ENV = "GMAIL_TOKEN_ENCRYPTION_KEY";
const ORIGINAL_KEY = process.env[GMAIL_KEY_ENV];

let userA: number;
let userB: number;
let connA: number;
let connB: number;

// ── Helpers ───────────────────────────────────────────────────────────────────
async function cleanup() {
  await db.execute(sql`DELETE FROM email_receipts WHERE user_id IN (${userA}, ${userB})`);
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

async function createReceipt(userId: number, connId: number, rawHtml: string) {
  const [row] = await db
    .insert(emailReceipts)
    .values({
      userId,
      gmailConnectionId: connId,
      gmailMsgId: `${TAG}${Date.now()}-${Math.random()}`,
      gateway: "mercado_pago",
      amountCents: BigInt(50000),
      occurredAt: new Date("2026-04-01T10:00:00Z"),
      merchant: "TestMerchant",
      currency: "COP",
      rawHtml,
      matchStatus: "pending",
    })
    .returning({ id: emailReceipts.id });
  return row.id;
}

function makeRequest(id: number | string) {
  return {
    request: new Request(`http://localhost/api/integrations/gmail/receipts/${id}/raw`),
    params: Promise.resolve({ id: String(id) }),
  };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
beforeAll(async () => {
  process.env[GMAIL_KEY_ENV] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  userA = await createUser("A");
  userB = await createUser("B");
  await createAccount(userA, "A");
  await createAccount(userB, "B");
  connA = await createConnection(userA);
  connB = await createConnection(userB);
});

afterEach(cleanup);

afterAll(async () => {
  await db.execute(sql`DELETE FROM gmail_connections WHERE user_id IN (${userA}, ${userB})`);
  await db.execute(sql`DELETE FROM accounts WHERE user_id IN (${userA}, ${userB})`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`);
  mockUser.value = null;
  if (ORIGINAL_KEY === undefined) delete process.env[GMAIL_KEY_ENV];
  else process.env[GMAIL_KEY_ENV] = ORIGINAL_KEY;
});

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("GET /api/integrations/gmail/receipts/[id]/raw", () => {
  it("returns 401 when not authenticated", async () => {
    mockUser.value = null;
    const { request, params } = makeRequest(1);
    const res = await GET(request, { params });
    expect(res.status).toBe(401);
  });

  it("returns the raw HTML with correct headers for the receipt owner", async () => {
    mockUser.value = {
      id: userA,
      email: `${TAG}A@test.local`,
      name: TAG,
      role: "user",
      active: true,
    };
    const html = "<html><body><h1>Receipt</h1></body></html>";
    const receiptId = await createReceipt(userA, connA, html);

    const { request, params } = makeRequest(receiptId);
    const res = await GET(request, { params });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe(html);

    expect(res.headers.get("Content-Type")).toContain("text/html");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 404 when the receipt belongs to a different user (tenant isolation)", async () => {
    mockUser.value = {
      id: userA,
      email: `${TAG}A@test.local`,
      name: TAG,
      role: "user",
      active: true,
    };
    const receiptIdB = await createReceipt(userB, connB, "<html>B</html>");

    const { request, params } = makeRequest(receiptIdB);
    const res = await GET(request, { params });
    expect(res.status).toBe(404);
  });

  it("returns 404 for a non-existent receipt id", async () => {
    mockUser.value = {
      id: userA,
      email: `${TAG}A@test.local`,
      name: TAG,
      role: "user",
      active: true,
    };
    const { request, params } = makeRequest(999999999);
    const res = await GET(request, { params });
    expect(res.status).toBe(404);
  });

  it("returns 404 for non-numeric id", async () => {
    mockUser.value = {
      id: userA,
      email: `${TAG}A@test.local`,
      name: TAG,
      role: "user",
      active: true,
    };
    const { request, params } = makeRequest("abc");
    const res = await GET(request, { params });
    expect(res.status).toBe(404);
  });

  it("returns 404 for soft-deleted receipts", async () => {
    mockUser.value = {
      id: userA,
      email: `${TAG}A@test.local`,
      name: TAG,
      role: "user",
      active: true,
    };
    const receiptId = await createReceipt(userA, connA, "<html>deleted</html>");
    await db.execute(sql`UPDATE email_receipts SET deleted_at = NOW() WHERE id = ${receiptId}`);

    const { request, params } = makeRequest(receiptId);
    const res = await GET(request, { params });
    expect(res.status).toBe(404);
  });
});
