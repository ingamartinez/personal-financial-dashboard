import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

const COOKIE_NAME = "findash_invite_code";
const TTL_SECONDS = 10 * 60;

function getSecret(): Uint8Array {
  const raw = process.env.AUTH_SECRET;
  if (!raw) {
    throw new Error("AUTH_SECRET is required to sign the invite cookie");
  }
  return new TextEncoder().encode(raw);
}

/**
 * Store the validated invite code in a short-lived, HttpOnly, signed cookie.
 * Called from `/signup` right before kicking off Google OAuth — the cookie
 * survives the OAuth round-trip and is read in the `signIn` callback to
 * atomically consume the code.
 */
export async function setInviteCookie(code: string): Promise<void> {
  const token = await new SignJWT({ code })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(getSecret());
  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: TTL_SECONDS,
  });
}

export async function readInviteCookie(): Promise<string | null> {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;
  if (!raw) return null;
  try {
    const { payload } = await jwtVerify(raw, getSecret());
    const code = payload.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

export async function clearInviteCookie(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export const INVITE_COOKIE_NAME = COOKIE_NAME;
