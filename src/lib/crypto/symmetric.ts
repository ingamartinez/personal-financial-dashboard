import crypto from "node:crypto";

const KEY_ENV = "TELEGRAM_TOKEN_ENCRYPTION_KEY";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export class InvalidTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTokenError";
  }
}

function loadKey(): Buffer {
  const raw = process.env[KEY_ENV];
  if (!raw) {
    throw new Error(
      `[crypto/symmetric] ${KEY_ENV} must be set. Generate with: openssl rand -base64 32`,
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `[crypto/symmetric] ${KEY_ENV} decodes to ${key.length} bytes; expected ${KEY_BYTES}. ` +
        `Generate with: openssl rand -base64 32`,
    );
  }
  return key;
}

const KEY = loadKey();

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, authTag]).toString("base64");
}

export function decrypt(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  if (buf.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new InvalidTokenError("payload too short");
  }
  const iv = buf.subarray(0, IV_BYTES);
  const authTag = buf.subarray(buf.length - AUTH_TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES, buf.length - AUTH_TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    throw new InvalidTokenError("auth tag mismatch — ciphertext tampered or wrong key");
  }
}
