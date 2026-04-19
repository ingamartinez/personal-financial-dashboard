import { NextResponse } from "next/server";
import { auth } from "@/auth";

// Names the Auth.js v5 JWT session cookie can go by, across http and https.
// We clear both on deactivation so the browser can't hold a stale token.
const SESSION_COOKIES = ["authjs.session-token", "__Secure-authjs.session-token"];

export default auth((req) => {
  const { pathname, search } = req.nextUrl;
  const session = req.auth;

  if (!session?.user) {
    const loginUrl = new URL("/login", req.nextUrl);
    loginUrl.searchParams.set("callbackUrl", pathname + search);
    return NextResponse.redirect(loginUrl);
  }

  // Deactivated users carry a still-valid JWT until expiry; the jwt callback
  // rewrote `active` from the DB on this request, so if we see `false` here
  // the ban is authoritative. Clear the cookie and kick them to /login with
  // a recognizable error code.
  if (session.user.active === false) {
    const loginUrl = new URL("/login", req.nextUrl);
    loginUrl.searchParams.set("error", "account-disabled");
    const res = NextResponse.redirect(loginUrl);
    for (const name of SESSION_COOKIES) res.cookies.delete(name);
    return res;
  }

  return NextResponse.next();
});

// Public endpoints (health check, bearer-token APIs, OAuth callbacks, static
// assets) must bypass the session-based proxy — otherwise they get 307'd to
// /login before their own handler (or Next.js's static handler) ever runs.
export const config = {
  matcher: [
    "/((?!api/auth|api/telegram/webhook|api/ingest|api/fx/refresh|api/health|api/dev/login|login|signup|_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|ico|webmanifest)$).*)",
  ],
};
