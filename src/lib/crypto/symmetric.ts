import crypto from "node:crypto";

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

export interface Cipher {
  encrypt(plaintext: string): string;
  decrypt(payload: string): string;
}

function loadKey(envName: string): Buffer {
  const raw = process.env[envName];
  if (!raw) {
    throw new Error(
      `[crypto/symmetric] ${envName} must be set. Generate with: openssl rand -base64 32`,
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `[crypto/symmetric] ${envName} decodes to ${key.length} bytes; expected ${KEY_BYTES}. ` +
        `Generate with: openssl rand -base64 32`,
    );
  }
  return key;
}

// Lazy key load: importing this module — or a sibling cipher singleton —
// must NOT throw at build time when the env var is stubbed. The throw
// happens on first use (encrypt/decrypt call), giving clearer signal.
export function createCipher(envName: string): Cipher {
  let cachedKey: Buffer | null = null;
  const getKey = (): Buffer => (cachedKey ??= loadKey(envName));

  return {
    encrypt(plaintext: string): string {
      const key = getKey();
      const iv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return Buffer.concat([iv, ciphertext, authTag]).toString("base64");
    },

    decrypt(payload: string): string {
      const key = getKey();
      const buf = Buffer.from(payload, "base64");
      if (buf.length < IV_BYTES + AUTH_TAG_BYTES) {
        throw new InvalidTokenError("payload too short");
      }
      const iv = buf.subarray(0, IV_BYTES);
      const authTag = buf.subarray(buf.length - AUTH_TAG_BYTES);
      const ciphertext = buf.subarray(IV_BYTES, buf.length - AUTH_TAG_BYTES);
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);
      try {
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return plaintext.toString("utf8");
      } catch {
        throw new InvalidTokenError("auth tag mismatch — ciphertext tampered or wrong key");
      }
    },
  };
}
