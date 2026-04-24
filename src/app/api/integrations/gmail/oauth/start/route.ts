import { NextResponse } from "next/server";
import { getSessionUserOrNull } from "@/lib/auth/session";
import { GMAIL_SCOPES, newOAuth2ClientForFlow } from "@/lib/gmail/client";
import { signOAuthState } from "@/lib/gmail/oauth-state";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "gmail/oauth/start" });

export async function GET() {
  const user = await getSessionUserOrNull();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const state = signOAuthState(user.id);
  const oauth = newOAuth2ClientForFlow();
  // access_type=offline + prompt=consent forces Google to issue a
  // refresh_token EVERY time. Without prompt=consent Google omits it on
  // re-grants, leaving the connection unable to refresh past 1 hour.
  const url = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...GMAIL_SCOPES],
    state,
    include_granted_scopes: true,
  });

  log.info({ userId: user.id, event: "gmail_oauth_start" }, "redirecting user to Google consent");
  return NextResponse.redirect(url);
}
