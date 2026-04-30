// Integration tests for Wave 1 gmail_token_expired emitters (#657).
// Uses the real DB (findash_test) and a spy on emitNotification.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { gmailConnections, users } from "@/lib/db/schema";
import { gmailCipher } from "@/lib/crypto/gmail-cipher";
import * as emitModule from "@/lib/notifications/emit";
import type { AuthedGmailClient } from "./client";
import { GmailConnectionUnusableError } from "./client";
import { pullForUser } from "./pull";

const TAG = "GMAIL_EMIT_TEST";
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

beforeEach(() => {
  vi.restoreAllMocks();
});

// ── emitter 1: gmail_token_expired (GmailConnectionUnusableError — expired) ─

describe("gmail_token_expired — expired branch (connRow path)", () => {
  it("emits once with correct type, entityId, audience, priority", async () => {
    const spy = vi.spyOn(emitModule, "emitNotification").mockResolvedValue({ id: 999 });

    const getClient = async (): Promise<AuthedGmailClient> => {
      throw new GmailConnectionUnusableError("expired", "token expired");
    };

    await pullForUser(userId, {}, { getClient });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        type: "gmail_token_expired",
        entityId: String(connId),
        audience: "user",
        priority: "high",
      }),
    );
  });

  it("does NOT emit when status is invalid_credentials (no expired/revoked branch)", async () => {
    const spy = vi.spyOn(emitModule, "emitNotification").mockResolvedValue({ id: 999 });

    const getClient = async (): Promise<AuthedGmailClient> => {
      // Only "expired" and "revoked" trigger the connRow lookup + emitter.
      throw new GmailConnectionUnusableError("invalid_credentials" as never, "bad creds");
    };

    await pullForUser(userId, {}, { getClient });

    expect(spy).not.toHaveBeenCalled();
  });
});

// ── emitter 1: gmail_token_expired (invalid_grant during pull — authed path) ─

describe("gmail_token_expired — invalid_grant path (authed path)", () => {
  it("emits once with connectionId from authed.connection.id", async () => {
    const spy = vi.spyOn(emitModule, "emitNotification").mockResolvedValue({ id: 999 });

    const fakeAuthed: AuthedGmailClient = {
      oauth: {} as unknown,
      gmail: {
        users: {
          messages: {
            list: vi.fn().mockRejectedValue(
              Object.assign(new Error("invalid_grant"), {
                response: { status: 401, data: { error: "invalid_grant" } },
              }),
            ),
            get: vi.fn(),
          },
        },
      },
      connection: { id: connId, gmailEmail: `${TAG}@gmail.com`, accessTokenStale: false },
    } as unknown as AuthedGmailClient;

    const getClient = async () => fakeAuthed;

    await pullForUser(userId, { gateways: ["mercado_pago"] }, { getClient });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        type: "gmail_token_expired",
        entityId: String(connId),
        audience: "user",
        priority: "high",
      }),
    );
  });
});
