import crypto from "node:crypto";

import { env } from "../config/env.js";

// Authenticated symmetric encryption for secrets stored at rest (SMTP password,
// Google client secret). AES-256-GCM gives confidentiality + tamper detection.
const ALGO = "aes-256-gcm";
const PREFIX = "enc:v1:"; // marks an encrypted value; legacy plaintext has no prefix

// The env layer already guarantees a 64-hex-char (32-byte) key.
function getKey(): Buffer {
  return Buffer.from(env.ENCRYPTION_KEY, "hex");
}

// True if a stored value is already in our encrypted format.
export function isEncrypted(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}

// Encrypt a plaintext secret -> "enc:v1:<iv>:<authTag>:<ciphertext>" (all hex).
// Pass-through for null/empty so callers don't have to special-case.
export function encryptSecret<T extends string | null | undefined>(plaintext: T): T | string {
  if (plaintext == null || plaintext === "") return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${ct.toString("hex")}`;
}

// Decrypt a stored secret. Values without the prefix are treated as legacy
// plaintext and returned unchanged (so existing data keeps working).
export function decryptSecret<T extends string | null | undefined>(stored: T): T | string {
  if (!isEncrypted(stored)) return stored;
  const [, , ivHex, tagHex, ctHex] = stored.split(":");
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]);
  return pt.toString("utf8");
}
