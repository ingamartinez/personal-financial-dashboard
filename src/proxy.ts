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

// Routes under api/ingest and api/fx/refresh authenticate via bearer token
// in their own handlers; they must bypass the session-based proxy or they
// get 307-redirected to /login before the handler ever runs.
export const config = {
  matcher: [
    "/((?!api/auth|api/telegram/webhook|api/ingest|api/fx/refresh|login|signup|_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|ico|webmanifest)$).*)",
  ],
};
