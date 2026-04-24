import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCipher, InvalidTokenError } from "./symmetric";

// Dedicated env var so this test never collides with the real
// TELEGRAM_TOKEN_ENCRYPTION_KEY set by vitest.setup.ts (which other
// integration tests rely on for round-tripping with seeded data).
const TEST_KEY_ENV = "CRYPTO_SYMMETRIC_TEST_KEY";

describe("crypto/symmetric — createCipher", () => {
  beforeEach(() => {
    // 32 zero bytes, base64 — deterministic so tampering tests are stable.
    process.env[TEST_KEY_ENV] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  });

  afterEach(() => {
    delete process.env[TEST_KEY_ENV];
  });

  it("round-trips ascii plaintext", () => {
    const cipher = createCipher(TEST_KEY_ENV);
    const plaintext = "1234567890:AAHabc_def-ghi";
    expect(cipher.decrypt(cipher.encrypt(plaintext))).toBe(plaintext);
  });

  it("round-trips non-ascii plaintext", () => {
    const cipher = createCipher(TEST_KEY_ENV);
    const plaintext = "héllo 🌎 — ¡hola, mundo!";
    expect(cipher.decrypt(cipher.encrypt(plaintext))).toBe(plaintext);
  });

  it("round-trips empty string", () => {
    const cipher = createCipher(TEST_KEY_ENV);
    expect(cipher.decrypt(cipher.encrypt(""))).toBe("");
  });

  it("produces a different ciphertext on each call (random IV)", () => {
    const cipher = createCipher(TEST_KEY_ENV);
    const plaintext = "repeat";
    expect(cipher.encrypt(plaintext)).not.toBe(cipher.encrypt(plaintext));
  });

  it("decrypt rejects payload tampered in the ciphertext region", () => {
    const cipher = createCipher(TEST_KEY_ENV);
    const buf = Buffer.from(cipher.encrypt("sensitive"), "base64");
    // Flip a byte in the ciphertext body (after 12-byte IV, before 16-byte tag).
    buf[14] ^= 0x01;
    expect(() => cipher.decrypt(buf.toString("base64"))).toThrow(InvalidTokenError);
  });

  it("decrypt rejects payload tampered in the auth tag", () => {
    const cipher = createCipher(TEST_KEY_ENV);
    const buf = Buffer.from(cipher.encrypt("sensitive"), "base64");
    // Flip a byte in the last 16 bytes (auth tag).
    buf[buf.length - 1] ^= 0x01;
    expect(() => cipher.decrypt(buf.toString("base64"))).toThrow(InvalidTokenError);
  });

  it("decrypt rejects payload encrypted with a different key", () => {
    const cipher = createCipher(TEST_KEY_ENV);
    const wrongKey = Buffer.alloc(32, 0x2a);
    const iv = crypto.randomBytes(12);
    const aes = crypto.createCipheriv("aes-256-gcm", wrongKey, iv);
    const ciphertext = Buffer.concat([aes.update("hello", "utf8"), aes.final()]);
    const authTag = aes.getAuthTag();
    const payload = Buffer.concat([iv, ciphertext, authTag]).toString("base64");
    expect(() => cipher.decrypt(payload)).toThrow(InvalidTokenError);
  });

  it("decrypt rejects payload shorter than iv+tag minimum", () => {
    const cipher = createCipher(TEST_KEY_ENV);
    const tooShort = Buffer.alloc(10).toString("base64");
    expect(() => cipher.decrypt(tooShort)).toThrow(InvalidTokenError);
  });

  it("two ciphers from different env vars cannot decrypt each other's payloads", () => {
    const otherEnv = "CRYPTO_SYMMETRIC_OTHER_KEY";
    process.env[otherEnv] = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=";
    try {
      const a = createCipher(TEST_KEY_ENV);
      const b = createCipher(otherEnv);
      const payloadFromA = a.encrypt("only a should read this");
      expect(() => b.decrypt(payloadFromA)).toThrow(InvalidTokenError);
    } finally {
      delete process.env[otherEnv];
    }
  });

  it("loads the key lazily — createCipher succeeds with env unset, fails on first use", () => {
    const lazyEnv = "CRYPTO_SYMMETRIC_LAZY_KEY";
    delete process.env[lazyEnv];
    // No throw at construction.
    const cipher = createCipher(lazyEnv);
    // Throws on first use.
    expect(() => cipher.encrypt("hi")).toThrow(/CRYPTO_SYMMETRIC_LAZY_KEY must be set/);
    // Setting the env after the fact unblocks subsequent calls.
    process.env[lazyEnv] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    try {
      const lazyCipher = createCipher(lazyEnv);
      expect(lazyCipher.decrypt(lazyCipher.encrypt("hi"))).toBe("hi");
    } finally {
      delete process.env[lazyEnv];
    }
  });

  it("rejects a key that does not decode to 32 bytes", () => {
    const badEnv = "CRYPTO_SYMMETRIC_BAD_KEY";
    process.env[badEnv] = "dG9vLXNob3J0"; // base64("too-short") = 9 bytes
    try {
      const cipher = createCipher(badEnv);
      expect(() => cipher.encrypt("hi")).toThrow(/decodes to 9 bytes; expected 32/);
    } finally {
      delete process.env[badEnv];
    }
  });
});
