import { z } from "zod";
import { seal, unseal } from "@/lib/auth/seal";

/**
 * Mailbox tokens are sealed with their own key (TOKEN_ENCRYPTION_KEY, falling back to
 * SESSION_SECRET) before storage, so a database dump alone doesn't expose mail access.
 */
const TTL = 400 * 86_400;

function key(env: Record<string, string | undefined>) {
  const k = env.TOKEN_ENCRYPTION_KEY ?? env.SESSION_SECRET ?? "";
  if (k.length < 32) throw new Error("Set TOKEN_ENCRYPTION_KEY (or SESSION_SECRET) to at least 32 characters before connecting a mailbox.");
  return k;
}

export const graphTokens = z.object({ cache: z.string(), homeAccountId: z.string() });
export const gmailTokens = z.object({ refreshToken: z.string(), accessToken: z.string().optional(), expiresAt: z.number().optional() });

export const sealTokens = (payload: object, env: Record<string, string | undefined> = process.env) => seal(payload, key(env), "mailbox", TTL);
export const unsealTokens = <T>(token: string | null, schema: z.ZodType<T>, env: Record<string, string | undefined> = process.env) => unseal(token ?? undefined, key(env), "mailbox", schema);
