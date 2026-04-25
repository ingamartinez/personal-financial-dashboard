import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailReceipts, gmailConnections, users } from "@/lib/db/schema";
import { applyRejection } from "./disambiguate";

const TAG = "DISAMBIGUATE_TEST";
const GMAIL_KEY_ENV = "GMAIL_TOKEN_ENCRYPTION_KEY";
const ORIGINAL_GMAIL_KEY = process.env[GMAIL_KEY_ENV];

let userId: number;
let connectionId: number;

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

async function seedConnection(uid: number): Promise<number> {
  // Import after key is set in beforeAll.
  const { gmailCipher } = await import("@/lib/crypto/gmail-cipher");
  const [row] = await db
    .insert(gmailConnections)
    .values({
      userId: uid,
      gmailEmail: `${TAG}-${uid}@example.com`,
      accessTokenEnc: gmailCipher.encrypt("dummy-access"),
      refreshTokenEnc: gmailCipher.encrypt("dummy-refresh"),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "active",
    })
    .returning({ id: gmailConnections.id });
  return row.id;
}

async function seedAmbiguousReceipt(
  uid: number,
  connId: number,
  msgSuffix: string,
  candidateIds: number[],
): Promise<number> {
  const [row] = await db
    .insert(emailReceipts)
    .values({
      userId: uid,
      gmailConnectionId: connId,
      gmailMsgId: `${TAG}-${msgSuffix}`,
      gateway: "mercado_pago",
      rawHtml: "<html>test</html>",
      matchStatus: "ambiguous",
      matchCandidates: candidateIds,
      parsedAt: new Date(),
    })
    .returning({ id: emailReceipts.id });
  return row.id;
}

beforeAll(async () => {
  process.env[GMAIL_KEY_ENV] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  await cleanup();
  userId = await createUser("a");
  connectionId = await seedConnection(userId);
});

afterAll(async () => {
  if (ORIGINAL_GMAIL_KEY === undefined) delete process.env[GMAIL_KEY_ENV];
  else process.env[GMAIL_KEY_ENV] = ORIGINAL_GMAIL_KEY;
  await cleanup();
});

beforeEach(async () => {
  await db.delete(emailReceipts).where(sql`gmail_msg_id LIKE ${TAG + "%"}`);
});

describe("applyRejection", () => {
  it("removes a transactionId from a single ambiguous receipt", async () => {
    const receiptId = await seedAmbiguousReceipt(userId, connectionId, "r1", [100, 200]);
    const { rejected } = await applyRejection(userId, 100);
    expect(rejected).toBe(1);

    const [row] = await db
      .select({
        matchCandidates: emailReceipts.matchCandidates,
        matchStatus: emailReceipts.matchStatus,
      })
      .from(emailReceipts)
      .where(eq(emailReceipts.id, receiptId));
    expect(row.matchCandidates).toEqual([200]);
    expect(row.matchStatus).toBe("ambiguous");
  });

  it("flips match_status to unmatched when candidates become empty", async () => {
    const receiptId = await seedAmbiguousReceipt(userId, connectionId, "r2", [999]);
    await applyRejection(userId, 999);

    const [row] = await db
      .select({
        matchStatus: emailReceipts.matchStatus,
        matchCandidates: emailReceipts.matchCandidates,
      })
      .from(emailReceipts)
      .where(eq(emailReceipts.id, receiptId));
    expect(row.matchStatus).toBe("unmatched");
    expect(row.matchCandidates).toEqual([]);
  });

  it("is idempotent — second call on already-unmatched receipt does nothing", async () => {
    // Seed as unmatched (not ambiguous) — applyRejection should return 0
    const [receipt] = await db
      .insert(emailReceipts)
      .values({
        userId,
        gmailConnectionId: connectionId,
        gmailMsgId: `${TAG}-r3`,
        gateway: "mercado_pago",
        rawHtml: "<html>test</html>",
        matchStatus: "unmatched",
        matchCandidates: [],
        parsedAt: new Date(),
      })
      .returning({ id: emailReceipts.id });
    const { rejected } = await applyRejection(userId, 999);
    expect(rejected).toBe(0);

    // Ensure the row is untouched.
    const [row] = await db
      .select({ matchStatus: emailReceipts.matchStatus })
      .from(emailReceipts)
      .where(eq(emailReceipts.id, receipt.id));
    expect(row.matchStatus).toBe("unmatched");
  });

  it("does NOT affect receipts of a different user (cross-tenant safety)", async () => {
    const userB = await createUser("b-isolation");
    const connB = await seedConnection(userB);
    const receiptB = await seedAmbiguousReceipt(userB, connB, "r4-b", [42]);

    // Call applyRejection for userA with txId 42 — should NOT touch userB's receipt.
    await applyRejection(userId, 42);

    const [row] = await db
      .select({ matchStatus: emailReceipts.matchStatus })
      .from(emailReceipts)
      .where(and(eq(emailReceipts.id, receiptB), eq(emailReceipts.userId, userB)));
    // userB's receipt still has txId 42 as candidate.
    expect(row.matchStatus).toBe("ambiguous");
  });
});
