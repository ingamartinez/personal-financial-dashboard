import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { gmailConnections } from "@/lib/db/schema";
import { notDeleted } from "@/lib/db/helpers";
import { gmailCipher } from "@/lib/crypto/gmail-cipher";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "gmail/client" });

// Scopes requested at consent time. Listed as readonly array so callers can
// pass it directly to oauth.generateAuthUrl({ scope: GMAIL_SCOPES }) without
// readonly→mutable coercion.
//
// `userinfo.email` is REQUIRED for the callback's google.oauth2(...).userinfo.get()
// call to succeed. Without it the access token returns 401 UNAUTHENTICATED.
// Discovered via #462 — first connect happened to work via include_granted_scopes
// inheriting NextAuth's `email` grant, but post-disconnect (which calls
// oauth.revokeToken and wipes ALL grants) the reconnect failed.
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;

// Connection rows are loaded from gmail_connections; one of these errors is
// thrown for every reason the connection cannot serve a request. Callers
// pattern-match to decide between "redirect to /settings/integrations",
// "show re-auth nudge", or "log + 500".
export class GmailNotConnectedError extends Error {
  constructor(userId: number) {
    super(`user ${userId} has no active Gmail connection`);
    this.name = "GmailNotConnectedError";
  }
}

export class GmailConnectionUnusableError extends Error {
  readonly status: "expired" | "revoked" | "error";
  readonly reason: string | null;
  constructor(status: "expired" | "revoked" | "error", reason: string | null) {
    super(`Gmail connection is ${status}${reason ? `: ${reason}` : ""}`);
    this.name = "GmailConnectionUnusableError";
    this.status = status;
    this.reason = reason;
  }
}

function loadOAuthEnv(): { clientId: string; clientSecret: string; redirectUri: string } {
  const clientId = process.env.AUTH_GOOGLE_ID;
  const clientSecret = process.env.AUTH_GOOGLE_SECRET;
  const redirectUri = process.env.GMAIL_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "[gmail/client] AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET, and GMAIL_OAUTH_REDIRECT_URI must all be set",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

// Plain OAuth2 client without user credentials — used by the OAuth start
// route (to build the consent URL) and the callback route (to exchange the
// authorization code for tokens). No DB lookup, no scope checks.
export function newOAuth2ClientForFlow(): OAuth2Client {
  const { clientId, clientSecret, redirectUri } = loadOAuthEnv();
  return new OAuth2Client({ clientId, clientSecret, redirectUri });
}

export interface AuthedGmailClient {
  /** OAuth2 client with user credentials set; pass to googleapis calls. */
  oauth: OAuth2Client;
  /** Pre-bound `google.gmail({ auth: oauth })` for convenience. */
  gmail: ReturnType<typeof google.gmail>;
  /** Lightweight metadata about the connection row that produced this client. */
  connection: {
    id: number;
    gmailEmail: string;
    /** True if the access token was already past its expiry when loaded. */
    accessTokenStale: boolean;
  };
}

/**
 * Loads a user's Gmail connection, decrypts tokens, and returns an OAuth2
 * client wired for transparent refresh. The googleapis SDK auto-refreshes
 * on the first API call after expiry; we register a `tokens` listener that
 * persists the new access_token (and refresh_token, if rotated) back to
 * gmail_connections so the next process doesn't refresh again.
 *
 * Throws `GmailNotConnectedError` if no row exists, or
 * `GmailConnectionUnusableError` if status != 'active'. Callers downstream
 * (Gmail pull engine, /enriquecer command) catch invalid_grant from API
 * calls and call `markConnectionUnusable` to transition the row.
 */
export async function getAuthedClient(userId: number): Promise<AuthedGmailClient> {
  const [row] = await db
    .select()
    .from(gmailConnections)
    .where(and(eq(gmailConnections.userId, userId), notDeleted(gmailConnections.deletedAt)))
    .limit(1);

  if (!row) throw new GmailNotConnectedError(userId);
  if (row.status !== "active") {
    throw new GmailConnectionUnusableError(row.status, row.statusReason);
  }

  const accessToken = gmailCipher.decrypt(row.accessTokenEnc);
  const refreshToken = gmailCipher.decrypt(row.refreshTokenEnc);

  const { clientId, clientSecret, redirectUri } = loadOAuthEnv();
  const oauth = new OAuth2Client({ clientId, clientSecret, redirectUri });
  oauth.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: row.accessTokenExpiresAt.getTime(),
    scope: row.scopes.join(" "),
    token_type: "Bearer",
  });

  // Persist refreshed tokens. Google omits refresh_token on refresh unless it
  // rotated, so only update that column when present. Fire-and-forget — if
  // the persist fails, the next process refreshes again and we log the miss.
  oauth.on("tokens", (tokens) => {
    if (!tokens.access_token || !tokens.expiry_date) return;
    const update: {
      accessTokenEnc: string;
      accessTokenExpiresAt: Date;
      updatedAt: Date;
      refreshTokenEnc?: string;
    } = {
      accessTokenEnc: gmailCipher.encrypt(tokens.access_token),
      accessTokenExpiresAt: new Date(tokens.expiry_date),
      updatedAt: new Date(),
    };
    if (tokens.refresh_token) {
      update.refreshTokenEnc = gmailCipher.encrypt(tokens.refresh_token);
    }
    db.update(gmailConnections)
      .set(update)
      .where(eq(gmailConnections.id, row.id))
      .catch((err: unknown) => {
        log.error(
          { err, connectionId: row.id, event: "gmail_refresh_persist_failed" },
          "failed to persist refreshed Gmail tokens",
        );
      });
  });

  return {
    oauth,
    gmail: google.gmail({ version: "v1", auth: oauth }),
    connection: {
      id: row.id,
      gmailEmail: row.gmailEmail,
      accessTokenStale: row.accessTokenExpiresAt.getTime() < Date.now(),
    },
  };
}

/**
 * Transition a connection out of 'active'. Called by downstream code that
 * catches invalid_grant (refresh token revoked or expired — testing-mode
 * 7-day cap), or by the disconnect handler. Idempotent.
 */
export async function markConnectionUnusable(
  connectionId: number,
  status: "expired" | "revoked" | "error",
  reason: string,
): Promise<void> {
  await db
    .update(gmailConnections)
    .set({ status, statusReason: reason, updatedAt: new Date() })
    .where(eq(gmailConnections.id, connectionId));
  log.warn(
    { connectionId, status, reason, event: "gmail_connection_unusable" },
    "Gmail connection marked unusable",
  );
}

/**
 * Heuristic for "this error is invalid_grant" — google-auth-library doesn't
 * expose a typed error class for it. We check both the structured response
 * (HTTP 400 with `error: 'invalid_grant'`) and the message string fallback.
 */
export function isInvalidGrantError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { response?: { data?: { error?: string } }; message?: string };
  if (e.response?.data?.error === "invalid_grant") return true;
  if (typeof e.message === "string" && e.message.includes("invalid_grant")) return true;
  return false;
}
