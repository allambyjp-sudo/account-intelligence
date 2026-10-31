import { CryptoProvider } from "@azure/msal-node";
import { NextResponse, type NextRequest } from "next/server";
import { readAuthConfig } from "@/lib/auth/config";
import { getCurrentUser } from "@/lib/auth/current-user";
import { publicUrl } from "@/lib/auth/http";
import { cookieOptions, createLoginToken, LOGIN_COOKIE, LOGIN_TTL_SECONDS } from "@/lib/auth/session";
import { GRAPH_MAIL_SCOPES, graphClient } from "@/lib/email/connections";
import { realMailboxPolicy } from "@/lib/email/policy";

/** Starts delegated Mail.Read consent for the signed-in seller's own Outlook mailbox. */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(publicUrl(req, "/signin?returnTo=/inbox"));
  const policy = realMailboxPolicy();
  if (!policy.allowed) return NextResponse.redirect(publicUrl(req, "/inbox?error=not_approved"));
  const cfg = readAuthConfig();
  if (!cfg.entra) return NextResponse.redirect(publicUrl(req, "/inbox?error=entra_not_configured"));

  const crypto = new CryptoProvider();
  const { verifier, challenge } = await crypto.generatePkceCodes();
  const state = crypto.createNewGuid();
  const redirectUri = new URL("/api/connect/graph/callback", cfg.entra.redirectUri).href;
  const url = await graphClient(cfg.entra, null, async () => {}).getAuthCodeUrl({
    scopes: GRAPH_MAIL_SCOPES,
    redirectUri,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    state,
    loginHint: user.email,
  });
  const res = NextResponse.redirect(url);
  res.cookies.set(LOGIN_COOKIE, createLoginToken(cfg, { state, verifier, returnTo: "/inbox" }), cookieOptions(cfg, LOGIN_TTL_SECONDS, "/api/connect"));
  return res;
}
