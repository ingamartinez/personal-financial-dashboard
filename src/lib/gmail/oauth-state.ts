import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// CSRF state for the Gmail OAuth flow. The state parameter Google echoes
// back to /callback is HMAC-signed with AUTH_SECRET so a third party can't
// forge a callback that targets another user's session. The payload also
// embeds the userId — we cross-check it against the session in /callback
// so that even a logged-in attacker can't graft their callback onto a
// victim's request (login-CSRF style).

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SEPARATOR = ".";

interface StatePayload {
  userId: number;
  nonce: string;
  exp: number; // unix ms
}

function loadSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("[gmail/oauth-state] AUTH_SECRET must be set to sign OAuth state");
  }
  return secret;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function signOAuthState(userId: number): string {
  const payload: StatePayload = {
    userId,
    nonce: randomBytes(16).toString("hex"),
    exp: Date.now() + STATE_TTL_MS,
  };
  const body = base64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = base64url(createHmac("sha256", loadSecret()).update(body).digest());
  return `${body}${SEPARATOR}${sig}`;
}

export class InvalidOAuthStateError extends Error {
  constructor(reason: string) {
    super(`OAuth state invalid: ${reason}`);
    this.name = "InvalidOAuthStateError";
  }
}

export function verifyOAuthState(state: string): StatePayload {
  const parts = state.split(SEPARATOR);
  if (parts.length !== 2) throw new InvalidOAuthStateError("malformed");
  const [body, sig] = parts;

  const expectedSig = base64url(createHmac("sha256", loadSecret()).update(body).digest());
  // Constant-time compare to defeat timing attacks.
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new InvalidOAuthStateError("signature mismatch");
  }

  let payload: StatePayload;
  try {
    payload = JSON.parse(fromBase64url(body).toString("utf8")) as StatePayload;
  } catch {
    throw new InvalidOAuthStateError("payload not valid JSON");
  }

  if (typeof payload.userId !== "number" || typeof payload.exp !== "number") {
    throw new InvalidOAuthStateError("payload missing fields");
  }
  if (payload.exp < Date.now()) {
    throw new InvalidOAuthStateError("expired");
  }
  return payload;
}
