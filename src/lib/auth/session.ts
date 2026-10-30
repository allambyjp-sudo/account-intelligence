import { z } from "zod";
import type { AuthConfig } from "./config";
import { seal, unseal } from "./seal";

export const SESSION_COOKIE = "aip_session";
export const LOGIN_COOKIE = "aip_login";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
export const LOGIN_TTL_SECONDS = 10 * 60;

const sessionSchema = z.object({ uid: z.uuid(), v: z.literal(1) });
export type SessionPayload = z.infer<typeof sessionSchema>;

const loginSchema = z.object({ state: z.string().min(16), verifier: z.string().min(43), returnTo: z.string() });
export type LoginState = z.infer<typeof loginSchema>;

export const createSessionToken = (cfg: AuthConfig, userId: string, now?: number) =>
  seal({ uid: userId, v: 1 }, cfg.sessionSecret, "session", SESSION_TTL_SECONDS, now);

export const readSessionToken = (cfg: AuthConfig, token: string | undefined, now?: number) =>
  unseal(token, cfg.sessionSecret, "session", sessionSchema, now);

export const createLoginToken = (cfg: AuthConfig, state: LoginState, now?: number) =>
  seal(state, cfg.sessionSecret, "login", LOGIN_TTL_SECONDS, now);

export const readLoginToken = (cfg: AuthConfig, token: string | undefined, now?: number) =>
  unseal(token, cfg.sessionSecret, "login", loginSchema, now);

export function cookieOptions(cfg: AuthConfig, maxAge: number, path = "/") {
  return { httpOnly: true, sameSite: "lax" as const, secure: cfg.secureCookies, path, maxAge };
}
