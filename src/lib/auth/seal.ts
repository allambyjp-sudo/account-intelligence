import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { z } from "zod";

/**
 * Authenticated encryption (AES-256-GCM) for cookie payloads. Each purpose derives its own key from
 * SESSION_SECRET, so a login-state cookie can never be replayed as a session cookie. Tampered,
 * expired or wrong-purpose tokens unseal to null.
 */
export type SealPurpose = "session" | "login";

const IV_BYTES = 12;
const TAG_BYTES = 16;

function keyFor(secret: string, purpose: SealPurpose): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "aip-cookie-v1", purpose, 32));
}

export function seal(payload: object, secret: string, purpose: SealPurpose, ttlSeconds: number, now = Date.now()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret, purpose), iv);
  cipher.setAAD(Buffer.from(purpose));
  const plain = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + ttlSeconds }));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
}

export function unseal<T>(token: string | undefined, secret: string, purpose: SealPurpose, schema: z.ZodType<T>, now = Date.now()): T | null {
  if (!token) return null;
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.length < IV_BYTES + TAG_BYTES + 1) return null;
    const decipher = createDecipheriv("aes-256-gcm", keyFor(secret, purpose), raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]);
    const data = JSON.parse(plain.toString("utf8")) as { exp?: unknown };
    if (typeof data.exp !== "number" || data.exp * 1000 <= now) return null;
    const parsed = schema.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
