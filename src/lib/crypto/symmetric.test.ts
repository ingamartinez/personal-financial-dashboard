import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt, InvalidTokenError } from "./symmetric";

describe("crypto/symmetric", () => {
  it("round-trips ascii plaintext", () => {
    const plaintext = "1234567890:AAHabc_def-ghi";
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it("round-trips non-ascii plaintext", () => {
    const plaintext = "héllo 🌎 — ¡hola, mundo!";
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it("round-trips empty string", () => {
    expect(decrypt(encrypt(""))).toBe("");
  });

  it("produces a different ciphertext on each call (random IV)", () => {
    const plaintext = "repeat";
    expect(encrypt(plaintext)).not.toBe(encrypt(plaintext));
  });

  it("decrypt rejects payload tampered in the ciphertext region", () => {
    const buf = Buffer.from(encrypt("sensitive"), "base64");
    // Flip a byte in the ciphertext body (after 12-byte IV, before 16-byte tag).
    buf[14] ^= 0x01;
    expect(() => decrypt(buf.toString("base64"))).toThrow(InvalidTokenError);
  });

  it("decrypt rejects payload tampered in the auth tag", () => {
    const buf = Buffer.from(encrypt("sensitive"), "base64");
    // Flip a byte in the last 16 bytes (auth tag).
    buf[buf.length - 1] ^= 0x01;
    expect(() => decrypt(buf.toString("base64"))).toThrow(InvalidTokenError);
  });

  it("decrypt rejects payload encrypted with a different key", () => {
    const wrongKey = Buffer.alloc(32, 0x2a);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", wrongKey, iv);
    const ciphertext = Buffer.concat([cipher.update("hello", "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const payload = Buffer.concat([iv, ciphertext, authTag]).toString("base64");
    expect(() => decrypt(payload)).toThrow(InvalidTokenError);
  });

  it("decrypt rejects payload shorter than iv+tag minimum", () => {
    const tooShort = Buffer.alloc(10).toString("base64");
    expect(() => decrypt(tooShort)).toThrow(InvalidTokenError);
  });
});
