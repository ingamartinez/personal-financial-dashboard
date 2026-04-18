import { NextResponse } from "next/server";
import { auth } from "@/auth";

export default auth((req) => {
  const isLoggedIn = !!req.auth;
  const { pathname, search } = req.nextUrl;

  if (!isLoggedIn) {
    const loginUrl = new URL("/login", req.nextUrl);
    loginUrl.searchParams.set("callbackUrl", pathname + search);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

// Public endpoints (health check, bearer-token APIs, OAuth callbacks, static
// assets) must bypass the session-based proxy — otherwise they get 307'd to
// /login before their own handler (or Next.js's static handler) ever runs.
export const config = {
  matcher: [
    "/((?!api/auth|api/telegram/webhook|api/ingest|api/fx/refresh|api/health|login|signup|_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|ico|webmanifest)$).*)",
  ],
};
