import { eq } from "drizzle-orm";
import { encode } from "next-auth/jwt";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";

const log = createLogger({ module: "api/dev/login" });

// Dev-only session bypass for local testing (chrome-devtools, curl, Playwright).
// Triple-gated so it is impossible to reach in production: NODE_ENV check,
// explicit DEV_AUTH_BYPASS=1 flag, and a Host-header localhost check. When any
// guard fails the route returns 404 — never 403 — so the endpoint's existence
// is not revealed.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_COOKIE = "authjs.session-token";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const notFound = () => new NextResponse(null, { status: 404 });

export async function GET(req: Request) {
  if (process.env.NODE_ENV === "production") return notFound();
  if (process.env.DEV_AUTH_BYPASS !== "1") return notFound();

  const host = (req.headers.get("host") ?? "").toLowerCase();
  const isLocalHost =
    host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]");
  if (!isLocalHost) return notFound();

  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    return new NextResponse("AUTH_SECRET not set", { status: 500 });
  }

  const url = new URL(req.url);
  const email = url.searchParams.get("email");
  if (!email) {
    return new NextResponse("missing 'email' query param", { status: 400 });
  }

  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      active: users.active,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!row) {
    return new NextResponse(`user not found: ${email}`, { status: 404 });
  }
  if (!row.active) {
    return new NextResponse(`user is inactive: ${email}`, { status: 403 });
  }

  const token = await encode({
    token: {
      email: row.email,
      sub: String(row.id),
      name: row.name,
    },
    secret,
    salt: SESSION_COOKIE,
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  log.warn(
    { userId: row.id, email: row.email, event: "dev_auth_bypass_session_issued" },
    "issuing session — DEV_AUTH_BYPASS=1",
  );

  const redirectTarget = url.searchParams.get("redirect") ?? "/";
  const res = NextResponse.redirect(new URL(redirectTarget, req.url), 303);
  res.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}
