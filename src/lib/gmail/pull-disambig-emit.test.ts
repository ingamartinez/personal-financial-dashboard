// Integration test for Wave 1 gmail_disambiguation_required emitter (#657).
// Mocks matchReceipt to return "ambiguous" and spies on emitNotification.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailReceipts, gmailConnections, users } from "@/lib/db/schema";
import { gmailCipher } from "@/lib/crypto/gmail-cipher";
import * as emitModule from "@/lib/notifications/emit";
import type { AuthedGmailClient } from "./client";

// Static vi.mock must be at top level (hoisted by Vitest).
vi.mock("@/lib/gmail/matcher", () => ({
  matchReceipt: vi.fn(),
}));

// parsers returns "parsed" so the receipt proceeds to the matcher.
vi.mock("@/lib/gmail/parsers", () => ({
  parseReceipt: vi.fn().mockReturnValue({
    kind: "parsed",
    data: {
      merchant: "Test Merchant",
      amountCents: BigInt(10000),
      currency: "COP",
      occurredAt: new Date("2026-04-01T12:00:00Z"),
      referenceId: "ref-disambig-test",
    },
  }),
}));

// applyEnrichment won't be called for ambiguous, but import it to avoid errors.
vi.mock("@/lib/gmail/enrich", () => ({
  applyEnrichment: vi.fn().mockResolvedValue(undefined),
}));

const TAG = "GMAIL_DISAMBIG_EMIT";
let userId: number;
let connId: number;

const ORIGINAL_GMAIL_KEY = process.env.GMAIL_TOKEN_ENCRYPTION_KEY;

async function cleanup() {
  await db.delete(users).where(sql`email LIKE ${"%" + TAG + "%"}`);
}

beforeAll(async () => {
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  await cleanup();
  const [u] = await db
    .insert(users)
    .values({ email: `${TAG}@test.local`, name: TAG })
    .returning({ id: users.id });
  userId = u.id;
  const [c] = await db
    .insert(gmailConnections)
    .values({
      userId,
      gmailEmail: `${TAG}@gmail.com`,
      accessTokenEnc: gmailCipher.encrypt("dummy-access-token"),
      refreshTokenEnc: gmailCipher.encrypt("dummy-refresh-token"),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "active",
    })
    .returning({ id: gmailConnections.id });
  connId = c.id;
});

afterAll(async () => {
  await cleanup();
  if (ORIGINAL_GMAIL_KEY === undefined) delete process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
  else process.env.GMAIL_TOKEN_ENCRYPTION_KEY = ORIGINAL_GMAIL_KEY;
});

beforeEach(async () => {
  vi.restoreAllMocks();
  // Clean receipts between tests.
  await db
    .delete(emailReceipts)
    .where(and(eq(emailReceipts.userId, userId), sql`gmail_msg_id LIKE ${"%" + TAG + "%"}`));
});

describe("gmail_disambiguation_required emitter", () => {
  it("emits once with receipt.id as entityId when matchReceipt returns ambiguous", async () => {
    const { matchReceipt } = await import("@/lib/gmail/matcher");
    (matchReceipt as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ambiguous",
      candidateIds: [10, 11],
    });

    const spy = vi.spyOn(emitModule, "emitNotification").mockResolvedValue({ id: 999 });

    // Insert a pending receipt that the enrich loop will pick up.
    const [receipt] = await db
      .insert(emailReceipts)
      .values({
        userId,
        gmailConnectionId: connId,
        gateway: "mercado_pago",
        gmailMsgId: `${TAG}-msg-1`,
        rawHtml: "<html>body</html>",
        matchStatus: "pending",
        parsedAt: new Date(), // already parsed → skip parser, go straight to matcher
      })
      .returning({ id: emailReceipts.id });

    // pullForUser with a fakeAuthed that returns no new messages — only the
    // existing pending receipt is processed by processPendingEnrichReceipts.
    const fakeAuthed: AuthedGmailClient = {
      oauth: {} as unknown,
      gmail: {
        users: {
          messages: {
            list: vi.fn().mockResolvedValue({ data: { messages: [] } }),
            get: vi.fn(),
          },
        },
      },
      connection: { id: connId, gmailEmail: `${TAG}@gmail.com`, accessTokenStale: false },
    } as unknown as AuthedGmailClient;

    const { pullForUser } = await import("./pull");
    await pullForUser(
      userId,
      { gateways: ["mercado_pago"] },
      { getClient: async () => fakeAuthed },
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        type: "gmail_disambiguation_required",
        entityId: String(receipt.id),
        audience: "user",
        priority: "high",
      }),
    );
  });

  it("does NOT emit when matchReceipt returns matched", async () => {
    const { matchReceipt } = await import("@/lib/gmail/matcher");
    (matchReceipt as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "matched",
      transactionId: 5,
    });

    const spy = vi.spyOn(emitModule, "emitNotification").mockResolvedValue({ id: 999 });

    const [receipt] = await db
      .insert(emailReceipts)
      .values({
        userId,
        gmailConnectionId: connId,
        gateway: "mercado_pago",
        gmailMsgId: `${TAG}-msg-2`,
        rawHtml: "<html>body</html>",
        matchStatus: "pending",
        parsedAt: new Date(),
      })
      .returning({ id: emailReceipts.id });

    const fakeAuthed: AuthedGmailClient = {
      oauth: {} as unknown,
      gmail: {
        users: {
          messages: {
            list: vi.fn().mockResolvedValue({ data: { messages: [] } }),
            get: vi.fn(),
          },
        },
      },
      connection: { id: connId, gmailEmail: `${TAG}@gmail.com`, accessTokenStale: false },
    } as unknown as AuthedGmailClient;

    // applyEnrichment is mocked to avoid needing a real transaction.
    const { applyEnrichment } = await import("@/lib/gmail/enrich");
    (applyEnrichment as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const { pullForUser } = await import("./pull");
    await pullForUser(
      userId,
      { gateways: ["mercado_pago"] },
      { getClient: async () => fakeAuthed },
    );

    // Cleanup
    await db.delete(emailReceipts).where(eq(emailReceipts.id, receipt.id));

    expect(spy).not.toHaveBeenCalled();
  });
});
