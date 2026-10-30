import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readAuthConfig, safeReturnTo, type EntraConfig } from "@/lib/auth/config";
import { completeSignIn, SignInError } from "@/lib/auth/entra";
import { seal, unseal } from "@/lib/auth/seal";
import { createLoginToken, createSessionToken, readLoginToken, readSessionToken } from "@/lib/auth/session";

const SECRET = "x".repeat(40);
const env = (extra: Record<string, string> = {}) => ({ SESSION_SECRET: SECRET, ...extra });
const entraEnv = {
  ENTRA_TENANT_ID: "11111111-1111-1111-1111-111111111111",
  ENTRA_CLIENT_ID: "22222222-2222-2222-2222-222222222222",
  ENTRA_CLIENT_SECRET: "secret",
  ENTRA_REDIRECT_URI: "https://aip.example/api/auth/callback",
};
const schema = z.object({ n: z.number() });

describe("sealed cookies", () => {
  it("round-trips a payload", () => {
    expect(unseal(seal({ n: 1 }, SECRET, "session", 60), SECRET, "session", schema)).toEqual({ n: 1 });
  });

  it("rejects tampering, the wrong secret, the wrong purpose and expiry", () => {
    const token = seal({ n: 1 }, SECRET, "session", 60, 1_000_000);
    const flipped = Buffer.from(token, "base64url");
    flipped[20]! ^= 1;
    expect(unseal(flipped.toString("base64url"), SECRET, "session", schema, 1_000_000)).toBeNull();
    expect(unseal(token, "y".repeat(40), "session", schema, 1_000_000)).toBeNull();
    expect(unseal(token, SECRET, "login", schema, 1_000_000)).toBeNull();
    expect(unseal(token, SECRET, "session", schema, 1_000_000 + 61_000)).toBeNull();
    expect(unseal("garbage", SECRET, "session", schema)).toBeNull();
    expect(unseal(undefined, SECRET, "session", schema)).toBeNull();
  });

  it("issues session tokens that only work as sessions", () => {
    const cfg = readAuthConfig(env());
    const uid = "3f8a1b2c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    const token = createSessionToken(cfg, uid);
    expect(readSessionToken(cfg, token)?.uid).toBe(uid);
    expect(readLoginToken(cfg, token)).toBeNull();
    const login = createLoginToken(cfg, { state: "s".repeat(16), verifier: "v".repeat(43), returnTo: "/" });
    expect(readSessionToken(cfg, login)).toBeNull();
  });
});

describe("readAuthConfig", () => {
  it("requires a long session secret", () => {
    expect(() => readAuthConfig({ SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
  });

  it("refuses the dev sign-in in production, loudly", () => {
    expect(() => readAuthConfig(env({ NODE_ENV: "production", AUTH_DEV_BYPASS: "true", ...entraEnv }))).toThrow(/refused in production/);
  });

  it("allows the dev sign-in in development", () => {
    expect(readAuthConfig(env({ AUTH_DEV_BYPASS: "true" })).devBypass).toBe(true);
  });

  it("requires Entra in production", () => {
    expect(() => readAuthConfig(env({ NODE_ENV: "production" }))).toThrow(/Production needs Entra/);
  });

  it("rejects a half-configured Entra app and multi-tenant aliases", () => {
    expect(() => readAuthConfig(env({ ENTRA_CLIENT_ID: "x" }))).toThrow(/all of/);
    expect(() => readAuthConfig(env({ ...entraEnv, ENTRA_TENANT_ID: "common" }))).toThrow(/single-tenant/);
  });

  it("uses Secure cookies in production or behind HTTPS", () => {
    expect(readAuthConfig(env()).secureCookies).toBe(false);
    expect(readAuthConfig(env(entraEnv)).secureCookies).toBe(true);
  });
});

describe("safeReturnTo", () => {
  it("keeps same-site paths and drops everything else", () => {
    expect(safeReturnTo("/accounts/1?tab=brief")).toBe("/accounts/1?tab=brief");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "", null]) {
      expect(safeReturnTo(bad)).toBe("/");
    }
  });
});

describe("completeSignIn", () => {
  const cfg: EntraConfig = {
    tenantId: entraEnv.ENTRA_TENANT_ID,
    clientId: entraEnv.ENTRA_CLIENT_ID,
    clientSecret: "secret",
    redirectUri: entraEnv.ENTRA_REDIRECT_URI,
  };
  const login = { state: "state-0123456789abcdef", verifier: "v".repeat(43), returnTo: "/" };
  const claims = { tid: cfg.tenantId, oid: "user-oid", name: "Seller One", preferred_username: "seller@contoso.example" };

  it("returns the identity when state matches and the tenant is ours", async () => {
    let verifierSeen = "";
    const id = await completeSignIn(cfg, { code: "c", returnedState: login.state, login }, async (_code, verifier) => {
      verifierSeen = verifier;
      return claims;
    });
    expect(id).toEqual({ tenantId: cfg.tenantId, objectId: "user-oid", email: "seller@contoso.example", displayName: "Seller One" });
    expect(verifierSeen).toBe(login.verifier);
  });

  it("rejects a mismatched or missing state before exchanging the code", async () => {
    const exchange = async () => {
      throw new Error("should not be called");
    };
    await expect(completeSignIn(cfg, { code: "c", returnedState: "other", login }, exchange)).rejects.toBeInstanceOf(SignInError);
    await expect(completeSignIn(cfg, { code: "c", returnedState: login.state, login: null }, exchange)).rejects.toThrow(/expired/);
  });

  it("rejects accounts from another tenant", async () => {
    await expect(
      completeSignIn(cfg, { code: "c", returnedState: login.state, login }, async () => ({ ...claims, tid: "someone-else" })),
    ).rejects.toThrow(/different organisation/);
  });
});
