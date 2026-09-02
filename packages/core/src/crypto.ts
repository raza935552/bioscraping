// AES-256-GCM encryption for secrets stored in the database (API keys managed
// through the admin Settings page). The master key comes from SETTINGS_KEY
// (64 hex chars = 32 bytes); if unset it is derived from APP_SECRET so local
// dev works out of the box. In production, set a dedicated SETTINGS_KEY —
// rotating APP_SECRET then won't make stored secrets undecryptable.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const PREFIX = "gcm";

function masterKey(env = process.env): Buffer {
  const hex = env.SETTINGS_KEY;
  if (hex && /^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, "hex");
  const appSecret = env.APP_SECRET;
  if (!appSecret) throw new Error("SETTINGS_KEY or APP_SECRET required to encrypt/decrypt settings");
  // Deterministic 32-byte key derived from APP_SECRET (fixed salt).
  return scryptSync(appSecret, "biolinx-settings-kdf", 32);
}

/** Encrypt a secret → "gcm:<iv>:<tag>:<ciphertext>" (all base64). */
export function encryptSecret(plaintext: string, env = process.env): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(env), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

/** Decrypt a "gcm:…" blob. Throws if tampered or wrong key. */
export function decryptSecret(blob: string, env = process.env): string {
  const parts = blob.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error("malformed secret blob");
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", masterKey(env), Buffer.from(ivB64!, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64!, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64!, "base64")), decipher.final()]).toString("utf8");
}

export function isEncrypted(value: string | null | undefined): boolean {
  return !!value && value.startsWith(PREFIX + ":");
}

/** Generate a fresh 32-byte SETTINGS_KEY (hex) for a new deployment. */
export function generateSettingsKey(): string {
  return randomBytes(32).toString("hex");
}
