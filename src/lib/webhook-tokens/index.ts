import { randomBytes, createHash } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { webhookTokens } from "@/lib/db/schema";

export type WebhookPurpose = "sms" | "debug";

export const WEBHOOK_PURPOSES: readonly WebhookPurpose[] = ["sms", "debug"] as const;

export function hashWebhookToken(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

function generatePlaintext(): string {
  // 32 bytes → 64 hex chars. Fits the token_hash varchar(64) one-to-one with
  // the SHA-256 digest, avoids ambiguous URL characters.
  return randomBytes(32).toString("hex");
}

export async function mintWebhookToken(opts: {
  userId: number;
  purpose: WebhookPurpose;
  label?: string | null;
}): Promise<{ id: number; plaintext: string }> {
  const plaintext = generatePlaintext();
  const tokenHash = hashWebhookToken(plaintext);
  const [row] = await db
    .insert(webhookTokens)
    .values({
      userId: opts.userId,
      purpose: opts.purpose,
      tokenHash,
      label: opts.label?.trim() || null,
    })
    .returning({ id: webhookTokens.id });
  return { id: row.id, plaintext };
}

export async function revokeWebhookToken(opts: {
  userId: number;
  tokenId: number;
}): Promise<boolean> {
  const result = await db
    .update(webhookTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(webhookTokens.id, opts.tokenId),
        eq(webhookTokens.userId, opts.userId),
        isNull(webhookTokens.revokedAt),
      ),
    )
    .returning({ id: webhookTokens.id });
  return result.length > 0;
}

export async function listWebhookTokensForUser(userId: number) {
  return db
    .select({
      id: webhookTokens.id,
      purpose: webhookTokens.purpose,
      label: webhookTokens.label,
      createdAt: webhookTokens.createdAt,
      lastUsedAt: webhookTokens.lastUsedAt,
      revokedAt: webhookTokens.revokedAt,
    })
    .from(webhookTokens)
    .where(eq(webhookTokens.userId, userId))
    .orderBy(desc(webhookTokens.createdAt));
}

export type ResolvedWebhookAuth = {
  userId: number;
  source: "per-user-token" | "legacy-env-token";
  tokenId: number | null;
};

/**
 * Resolves a webhook request's userId from an `Authorization: Bearer <token>`
 * header. Tries the per-user webhook_tokens table first; if that misses, falls
 * back to the legacy INGEST_WEBHOOK_TOKEN env var (attributes to user 1).
 *
 * Returns null if neither path authenticates. Callers must NOT leak which path
 * succeeded in error messages — both misses return the same null.
 */
export async function resolveWebhookAuth(opts: {
  authHeader: string | null;
  purpose: WebhookPurpose;
}): Promise<ResolvedWebhookAuth | null> {
  const provided = (opts.authHeader ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!provided) return null;

  const match = await lookupPerUserToken(provided, opts.purpose);
  if (match) {
    void markTokenUsed(match.tokenId);
    return { userId: match.userId, source: "per-user-token", tokenId: match.tokenId };
  }

  const legacy = process.env.INGEST_WEBHOOK_TOKEN;
  if (legacy && provided === legacy) {
    return { userId: 1, source: "legacy-env-token", tokenId: null };
  }

  return null;
}

async function lookupPerUserToken(
  plaintext: string,
  purpose: WebhookPurpose,
): Promise<{ userId: number; tokenId: number } | null> {
  const tokenHash = hashWebhookToken(plaintext);
  const [row] = await db
    .select({ id: webhookTokens.id, userId: webhookTokens.userId })
    .from(webhookTokens)
    .where(
      and(
        eq(webhookTokens.tokenHash, tokenHash),
        eq(webhookTokens.purpose, purpose),
        isNull(webhookTokens.revokedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  return { userId: row.userId, tokenId: row.id };
}

async function markTokenUsed(tokenId: number): Promise<void> {
  try {
    await db
      .update(webhookTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(webhookTokens.id, tokenId));
  } catch {
    // Fire-and-forget: a failed last_used_at update must not fail ingestion.
  }
}

export async function countActiveTokensByPurpose(
  userId: number,
): Promise<Record<WebhookPurpose, number>> {
  const rows = await db
    .select({
      purpose: webhookTokens.purpose,
      count: sql<number>`count(*)::int`,
    })
    .from(webhookTokens)
    .where(and(eq(webhookTokens.userId, userId), isNull(webhookTokens.revokedAt)))
    .groupBy(webhookTokens.purpose);
  const result: Record<WebhookPurpose, number> = { sms: 0, debug: 0 };
  for (const row of rows) {
    result[row.purpose as WebhookPurpose] = row.count;
  }
  return result;
}
