import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidOAuthStateError, signOAuthState, verifyOAuthState } from "./oauth-state";

const ORIGINAL_AUTH_SECRET = process.env.AUTH_SECRET;
const TEST_SECRET = "test-secret-for-hmac-signing-only";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("gmail/oauth-state", () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (ORIGINAL_AUTH_SECRET === undefined) {
      delete process.env.AUTH_SECRET;
    } else {
      process.env.AUTH_SECRET = ORIGINAL_AUTH_SECRET;
    }
  });

  it("round-trips a signed state for a user", () => {
    const state = signOAuthState(42);
    const payload = verifyOAuthState(state);
    expect(payload.userId).toBe(42);
    expect(payload.exp).toBeGreaterThan(Date.now());
    expect(payload.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("produces a different state per call (random nonce)", () => {
    const a = signOAuthState(1);
    const b = signOAuthState(1);
    expect(a).not.toBe(b);
  });

  it("rejects a malformed state (no separator)", () => {
    expect(() => verifyOAuthState("nodothere")).toThrow(InvalidOAuthStateError);
  });

  it("rejects a state with tampered payload", () => {
    const state = signOAuthState(1);
    const [body, sig] = state.split(".");
    // Flip a character in the body — HMAC will not match.
    const tampered = `${body.slice(0, -1)}${body.slice(-1) === "A" ? "B" : "A"}.${sig}`;
    expect(() => verifyOAuthState(tampered)).toThrow(InvalidOAuthStateError);
  });

  it("rejects a state with tampered signature", () => {
    const state = signOAuthState(1);
    const [body, sig] = state.split(".");
    const tampered = `${body}.${sig.slice(0, -1)}${sig.slice(-1) === "A" ? "B" : "A"}`;
    expect(() => verifyOAuthState(tampered)).toThrow(InvalidOAuthStateError);
  });

  it("rejects a state signed with a different secret", () => {
    const state = signOAuthState(1);
    process.env.AUTH_SECRET = "different-secret";
    expect(() => verifyOAuthState(state)).toThrow(InvalidOAuthStateError);
  });

  it("rejects an expired state", () => {
    // Build a state with a past exp, signed with the real secret so the only
    // invalid bit is exp itself.
    const payload = { userId: 9, nonce: "f".repeat(32), exp: Date.now() - 1000 };
    const body = base64url(Buffer.from(JSON.stringify(payload), "utf8"));
    const sig = base64url(createHmac("sha256", TEST_SECRET).update(body).digest());
    expect(() => verifyOAuthState(`${body}.${sig}`)).toThrow(/expired/);
  });

  it("throws when AUTH_SECRET is missing", () => {
    delete process.env.AUTH_SECRET;
    expect(() => signOAuthState(1)).toThrow(/AUTH_SECRET must be set/);
  });

  it("uses constant-time comparison (signatures of different length are rejected)", () => {
    const state = signOAuthState(1);
    const [body, sig] = state.split(".");
    // A truncated signature must be rejected without crashing.
    expect(() => verifyOAuthState(`${body}.${sig.slice(0, 5)}`)).toThrow(InvalidOAuthStateError);
  });
});
