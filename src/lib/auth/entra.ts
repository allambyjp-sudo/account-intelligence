import { ConfidentialClientApplication, CryptoProvider } from "@azure/msal-node";
import type { EntraConfig } from "./config";
import type { LoginState } from "./session";

/**
 * Microsoft Entra ID sign-in: authorization code flow with PKCE, single tenant. Phase 6 extends the
 * same app registration with delegated Mail.Read (incremental consent), so one Microsoft library
 * handles both sign-in and Graph tokens.
 */
export const SIGN_IN_SCOPES = ["User.Read"];

export interface EntraIdentity {
  tenantId: string;
  objectId: string;
  email: string;
  displayName: string;
}

export class SignInError extends Error {
  override name = "SignInError";
}

function client(cfg: EntraConfig) {
  return new ConfidentialClientApplication({
    auth: {
      clientId: cfg.clientId,
      authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
      clientSecret: cfg.clientSecret,
    },
  });
}

export async function beginSignIn(cfg: EntraConfig, returnTo: string): Promise<{ url: string; state: LoginState }> {
  const crypto = new CryptoProvider();
  const { verifier, challenge } = await crypto.generatePkceCodes();
  const state = crypto.createNewGuid();
  const url = await client(cfg).getAuthCodeUrl({
    scopes: SIGN_IN_SCOPES,
    redirectUri: cfg.redirectUri,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    state,
    prompt: "select_account",
  });
  return { url, state: { state, verifier, returnTo } };
}

/** The code-for-token exchange, injectable so the checks around it can be tested without Entra. */
export type CodeExchange = (code: string, verifier: string) => Promise<Record<string, unknown>>;

export const msalExchange =
  (cfg: EntraConfig): CodeExchange =>
  async (code, verifier) => {
    const result = await client(cfg).acquireTokenByCode({
      code,
      codeVerifier: verifier,
      scopes: SIGN_IN_SCOPES,
      redirectUri: cfg.redirectUri,
    });
    return (result.idTokenClaims ?? {}) as Record<string, unknown>;
  };

export async function completeSignIn(
  cfg: EntraConfig,
  input: { code: string | null; returnedState: string | null; login: LoginState | null },
  exchange: CodeExchange = msalExchange(cfg),
): Promise<EntraIdentity> {
  if (!input.login) throw new SignInError("Your sign-in attempt expired. Please try again.");
  if (!input.code || !input.returnedState || input.returnedState !== input.login.state) {
    throw new SignInError("The sign-in response didn't match the request. Please try again.");
  }
  const claims = await exchange(input.code, input.login.verifier);
  const tid = typeof claims.tid === "string" ? claims.tid : "";
  const oid = typeof claims.oid === "string" ? claims.oid : "";
  if (tid.toLowerCase() !== cfg.tenantId.toLowerCase()) {
    throw new SignInError("That account belongs to a different organisation.");
  }
  if (!oid) throw new SignInError("Entra didn't return a user ID.");
  const email = [claims.email, claims.preferred_username].find((v): v is string => typeof v === "string" && v.includes("@"));
  return {
    tenantId: tid,
    objectId: oid,
    email: email ?? "",
    displayName: typeof claims.name === "string" && claims.name ? claims.name : (email ?? "Signed-in user"),
  };
}
