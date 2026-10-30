type Env = Record<string, string | undefined>;

export interface EntraConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface AuthConfig {
  sessionSecret: string;
  isProduction: boolean;
  /** A one-click local sign-in for development. Never available in production. */
  devBypass: boolean;
  /** Null until the Entra app registration exists (docs/entra-sign-in-setup.md). */
  entra: EntraConfig | null;
  secureCookies: boolean;
}

export class AuthConfigError extends Error {
  override name = "AuthConfigError";
}

export function readAuthConfig(env: Env = process.env): AuthConfig {
  const isProduction = env.NODE_ENV === "production";
  const secret = env.SESSION_SECRET ?? "";
  if (secret.length < 32) {
    throw new AuthConfigError("SESSION_SECRET must be at least 32 characters. Generate one with: openssl rand -base64 48");
  }

  const wantsBypass = env.AUTH_DEV_BYPASS === "true";
  if (wantsBypass && isProduction) {
    throw new AuthConfigError("AUTH_DEV_BYPASS=true is refused in production. Remove it from the environment.");
  }

  const { ENTRA_TENANT_ID: tenantId, ENTRA_CLIENT_ID: clientId, ENTRA_CLIENT_SECRET: clientSecret, ENTRA_REDIRECT_URI: redirectUri } = env;
  const anyEntra = Boolean(tenantId || clientId || clientSecret || redirectUri);
  const allEntra = Boolean(tenantId && clientId && clientSecret && redirectUri);
  if (anyEntra && !allEntra) {
    throw new AuthConfigError("Set all of ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET and ENTRA_REDIRECT_URI, or none of them.");
  }
  if (tenantId && ["common", "organizations", "consumers"].includes(tenantId.toLowerCase())) {
    throw new AuthConfigError("ENTRA_TENANT_ID must be your tenant's ID, not a multi-tenant alias. Sign-in is single-tenant.");
  }
  if (isProduction && !allEntra) {
    throw new AuthConfigError("Production needs Entra sign-in configured (ENTRA_* variables).");
  }

  return {
    sessionSecret: secret,
    isProduction,
    devBypass: wantsBypass,
    entra: allEntra ? { tenantId: tenantId!, clientId: clientId!, clientSecret: clientSecret!, redirectUri: redirectUri! } : null,
    secureCookies: isProduction || (redirectUri ?? "").startsWith("https://"),
  };
}

/** Only same-site relative paths, so the sign-in flow can't be used as an open redirect. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}
