// Auth primitives: scrypt password hashing (node:crypto, zero deps) and
// HMAC-signed session tokens carried in an httpOnly cookie. Invite-based
// account creation only — there is no open registration.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16384;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: SCRYPT_N });
  return `scrypt:${SCRYPT_N}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const [, nStr, saltHex, hashHex] = parts;
  const expected = Buffer.from(hashHex!, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex!, "hex"), expected.length, {
    N: Number(nStr),
  });
  return timingSafeEqual(actual, expected);
}

// ── Session tokens ──────────────────────────────────────────────────────

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function secret(): string {
  const s = process.env.APP_SECRET;
  if (!s || s.length < 32) {
    throw new Error("APP_SECRET missing or too short (need ≥32 chars) — set it in .env");
  }
  return s;
}

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function sign(payload: string): string {
  return b64url(createHmac("sha256", secret()).update(payload).digest());
}

export function issueSessionToken(userId: number, sessionEpoch: number, now = Date.now()): string {
  const payload = b64url(JSON.stringify({ u: userId, s: sessionEpoch, e: now + SESSION_TTL_MS }));
  return `${payload}.${sign(payload)}`;
}

/** Returns { userId, epoch } if the token's signature + expiry are valid; the
 *  caller must still confirm epoch matches the user's current sessionEpoch. */
export function verifySessionToken(
  token: string | undefined,
  now = Date.now(),
): { userId: number; epoch: number } | null {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64").toString()) as { u?: number; s?: number; e?: number };
    if (typeof parsed.u !== "number" || typeof parsed.e !== "number") return null;
    if (parsed.e < now) return null;
    return { userId: parsed.u, epoch: parsed.s ?? 0 };
  } catch {
    return null;
  }
}

/** Dummy scrypt target so login timing doesn't reveal whether an email exists. */
export function dummyVerify(password: string): void {
  scryptSync(password, Buffer.from("timing-equalizer-salt"), 64, { N: SCRYPT_N });
}

export function newInviteToken(): string {
  return randomBytes(24).toString("hex");
}

export const SESSION_COOKIE = "bx_session";
