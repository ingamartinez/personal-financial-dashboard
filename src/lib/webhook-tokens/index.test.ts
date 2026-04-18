import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { webhookTokens } from "@/lib/db/schema";
import {
  hashWebhookToken,
  listWebhookTokensForUser,
  mintWebhookToken,
  resolveWebhookAuth,
  revokeWebhookToken,
} from ".";

const TEST_USER_ID = 1;
const LABEL_PREFIX = "vitest-webhook-tokens";

async function cleanup() {
  await db
    .delete(webhookTokens)
    .where(and(eq(webhookTokens.userId, TEST_USER_ID), eq(webhookTokens.label, LABEL_PREFIX)));
}

describe("webhook-tokens module", () => {
  beforeEach(cleanup);
  afterEach(cleanup);
  afterAll(async () => {
    delete process.env.INGEST_WEBHOOK_TOKEN;
    await db.$client.end({ timeout: 1 });
  });

  it("mintWebhookToken stores the hash and never the plaintext", async () => {
    const { id, plaintext } = await mintWebhookToken({
      userId: TEST_USER_ID,
      purpose: "sms",
      label: LABEL_PREFIX,
    });
    expect(plaintext).toMatch(/^[0-9a-f]{64}$/);
    const [row] = await db
      .select({ tokenHash: webhookTokens.tokenHash })
      .from(webhookTokens)
      .where(eq(webhookTokens.id, id));
    expect(row.tokenHash).toBe(hashWebhookToken(plaintext));
    expect(row.tokenHash).not.toBe(plaintext);
  });

  it("resolveWebhookAuth accepts a valid per-user token and returns userId", async () => {
    const { id, plaintext } = await mintWebhookToken({
      userId: TEST_USER_ID,
      purpose: "sms",
      label: LABEL_PREFIX,
    });
    const result = await resolveWebhookAuth({
      authHeader: `Bearer ${plaintext}`,
      purpose: "sms",
    });
    expect(result).not.toBeNull();
    expect(result?.userId).toBe(TEST_USER_ID);
    expect(result?.tokenId).toBe(id);
  });

  it("resolveWebhookAuth rejects a token minted for a different purpose", async () => {
    const { plaintext } = await mintWebhookToken({
      userId: TEST_USER_ID,
      purpose: "sms",
      label: LABEL_PREFIX,
    });
    const result = await resolveWebhookAuth({
      authHeader: `Bearer ${plaintext}`,
      purpose: "debug",
    });
    expect(result).toBeNull();
  });

  it("revokeWebhookToken disables a token and resolveWebhookAuth stops accepting it", async () => {
    const { id, plaintext } = await mintWebhookToken({
      userId: TEST_USER_ID,
      purpose: "sms",
      label: LABEL_PREFIX,
    });
    const revoked = await revokeWebhookToken({ userId: TEST_USER_ID, tokenId: id });
    expect(revoked).toBe(true);

    const result = await resolveWebhookAuth({
      authHeader: `Bearer ${plaintext}`,
      purpose: "sms",
    });
    expect(result).toBeNull();

    const retry = await revokeWebhookToken({ userId: TEST_USER_ID, tokenId: id });
    expect(retry).toBe(false);
  });

  it("resolveWebhookAuth ignores the retired INGEST_WEBHOOK_TOKEN env var", async () => {
    process.env.INGEST_WEBHOOK_TOKEN = "legacy-fallback-token-no-longer-honored";
    try {
      const result = await resolveWebhookAuth({
        authHeader: `Bearer legacy-fallback-token-no-longer-honored`,
        purpose: "sms",
      });
      expect(result).toBeNull();
    } finally {
      delete process.env.INGEST_WEBHOOK_TOKEN;
    }
  });

  it("resolveWebhookAuth returns null for missing header", async () => {
    const result = await resolveWebhookAuth({ authHeader: null, purpose: "sms" });
    expect(result).toBeNull();
  });

  it("listWebhookTokensForUser returns rows ordered newest first", async () => {
    const a = await mintWebhookToken({
      userId: TEST_USER_ID,
      purpose: "sms",
      label: LABEL_PREFIX,
    });
    await new Promise((r) => setTimeout(r, 5));
    const b = await mintWebhookToken({
      userId: TEST_USER_ID,
      purpose: "debug",
      label: LABEL_PREFIX,
    });
    const rows = await listWebhookTokensForUser(TEST_USER_ID);
    const ourRows = rows.filter((r) => r.label === LABEL_PREFIX);
    expect(ourRows.map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it("resolveWebhookAuth updates last_used_at on successful match", async () => {
    const { id, plaintext } = await mintWebhookToken({
      userId: TEST_USER_ID,
      purpose: "sms",
      label: LABEL_PREFIX,
    });
    const before = await db
      .select({ lastUsedAt: webhookTokens.lastUsedAt })
      .from(webhookTokens)
      .where(eq(webhookTokens.id, id));
    expect(before[0].lastUsedAt).toBeNull();

    await resolveWebhookAuth({ authHeader: `Bearer ${plaintext}`, purpose: "sms" });
    // fire-and-forget — give it a moment to settle
    await new Promise((r) => setTimeout(r, 50));

    const after = await db
      .select({ lastUsedAt: webhookTokens.lastUsedAt })
      .from(webhookTokens)
      .where(and(eq(webhookTokens.id, id), isNull(webhookTokens.revokedAt)));
    expect(after[0].lastUsedAt).not.toBeNull();
  });
});
