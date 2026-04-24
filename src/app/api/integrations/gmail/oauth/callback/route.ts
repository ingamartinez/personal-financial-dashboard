import { type NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { gmailConnections } from "@/lib/db/schema";
import { getSessionUserOrNull } from "@/lib/auth/session";
import { gmailCipher } from "@/lib/crypto/gmail-cipher";
import { GMAIL_SCOPES, newOAuth2ClientForFlow } from "@/lib/gmail/client";
import { InvalidOAuthStateError, verifyOAuthState } from "@/lib/gmail/oauth-state";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "gmail/oauth/callback" });

// Lands the user back on /settings/integrations with a one-time toast key.
// We never bake error details into the URL — the page renders a generic
// message and logs the structured detail server-side.
function redirectToSettings(reason: "success" | "error" | "denied" | "csrf" | "no_refresh") {
  return NextResponse.redirect(
    new URL(
      `/settings/integrations?gmail=${reason}`,
      process.env.AUTH_URL ?? "http://localhost:3100",
    ),
  );
}

export async function GET(req: NextRequest) {
  const sessionUser = await getSessionUserOrNull();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  // User clicked "Cancel" on Google's consent screen.
  if (errorParam) {
    log.info(
      { userId: sessionUser.id, error: errorParam, event: "gmail_oauth_user_denied" },
      "user denied Gmail consent",
    );
    return redirectToSettings("denied");
  }

  if (!code || !state) {
    log.warn(
      {
        userId: sessionUser.id,
        hasCode: !!code,
        hasState: !!state,
        event: "gmail_oauth_missing_params",
      },
      "callback missing code or state",
    );
    return redirectToSettings("error");
  }

  // Verify state: HMAC + TTL + userId match. Any failure → CSRF / replay.
  let statePayload;
  try {
    statePayload = verifyOAuthState(state);
  } catch (err) {
    if (err instanceof InvalidOAuthStateError) {
      log.warn(
        { userId: sessionUser.id, reason: err.message, event: "gmail_oauth_state_invalid" },
        "OAuth state failed verification",
      );
    } else {
      log.error(
        { err, event: "gmail_oauth_state_unexpected" },
        "unexpected error verifying OAuth state",
      );
    }
    return redirectToSettings("csrf");
  }

  if (statePayload.userId !== sessionUser.id) {
    log.warn(
      {
        sessionUserId: sessionUser.id,
        stateUserId: statePayload.userId,
        event: "gmail_oauth_state_user_mismatch",
      },
      "OAuth state userId did not match session",
    );
    return redirectToSettings("csrf");
  }

  // Exchange code for tokens.
  const oauth = newOAuth2ClientForFlow();
  let tokens;
  try {
    const { tokens: t } = await oauth.getToken(code);
    tokens = t;
  } catch (err) {
    log.error(
      { err, userId: sessionUser.id, event: "gmail_oauth_code_exchange_failed" },
      "failed to exchange code for tokens",
    );
    return redirectToSettings("error");
  }

  if (!tokens.access_token || !tokens.expiry_date) {
    log.error(
      { userId: sessionUser.id, event: "gmail_oauth_no_access_token" },
      "Google returned no access_token",
    );
    return redirectToSettings("error");
  }
  // Without a refresh_token we can never refresh — the connection would
  // die in 1 hour. This happens if the user already granted access in a
  // previous (concurrent) session and Google decided to skip re-issuing it.
  // Telling the user to retry usually fixes it because we always pass
  // prompt=consent.
  if (!tokens.refresh_token) {
    log.warn(
      { userId: sessionUser.id, event: "gmail_oauth_no_refresh_token" },
      "Google did not return refresh_token — cannot persist connection",
    );
    return redirectToSettings("no_refresh");
  }

  // Discover the user's actual gmail address from the userinfo endpoint —
  // can't trust the session email here because the user might link a
  // different Google account than the one they logged into findash with.
  oauth.setCredentials(tokens);
  let gmailEmail: string;
  try {
    const { data } = await google.oauth2({ version: "v2", auth: oauth }).userinfo.get();
    if (!data.email) throw new Error("userinfo returned no email");
    gmailEmail = data.email;
  } catch (err) {
    log.error(
      { err, userId: sessionUser.id, event: "gmail_oauth_userinfo_failed" },
      "failed to fetch userinfo after token exchange",
    );
    return redirectToSettings("error");
  }

  // Upsert: a row may already exist if the user previously connected the
  // same gmail address and disconnected. Soft-deleted rows allow re-insert
  // because the unique index is partial on deleted_at IS NULL — but the
  // cleanest path is to UPDATE if a non-deleted row exists for the same
  // (userId, gmailEmail). For a different email, we insert a new row, and
  // archive the previous active row for this user (one-Gmail-per-user
  // policy for now — multi-account is post-MVP).
  const accessTokenEnc = gmailCipher.encrypt(tokens.access_token);
  const refreshTokenEnc = gmailCipher.encrypt(tokens.refresh_token);
  const accessTokenExpiresAt = new Date(tokens.expiry_date);
  const scopes = tokens.scope ? tokens.scope.split(" ") : [...GMAIL_SCOPES];

  await db.transaction(async (tx) => {
    // Archive any other active connection rows for this user — single
    // active Gmail per user in V1.
    await tx
      .update(gmailConnections)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(gmailConnections.userId, sessionUser.id),
          sql`${gmailConnections.gmailEmail} <> ${gmailEmail}`,
          sql`${gmailConnections.deletedAt} IS NULL`,
        ),
      );

    await tx
      .insert(gmailConnections)
      .values({
        userId: sessionUser.id,
        gmailEmail,
        accessTokenEnc,
        refreshTokenEnc,
        accessTokenExpiresAt,
        scopes,
        status: "active",
        statusReason: null,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: [gmailConnections.userId, gmailConnections.gmailEmail],
        targetWhere: sql`${gmailConnections.deletedAt} IS NULL`,
        set: {
          accessTokenEnc,
          refreshTokenEnc,
          accessTokenExpiresAt,
          scopes,
          status: "active",
          statusReason: null,
          updatedAt: new Date(),
        },
      });
  });

  log.info(
    { userId: sessionUser.id, gmailEmail, event: "gmail_oauth_connected" },
    "Gmail connected",
  );
  return redirectToSettings("success");
}
