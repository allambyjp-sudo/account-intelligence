import { CryptoProvider } from "@azure/msal-node";
import { NextResponse, type NextRequest } from "next/server";
import { readAuthConfig } from "@/lib/auth/config";
import { getCurrentUser } from "@/lib/auth/current-user";
import { publicUrl } from "@/lib/auth/http";
import { cookieOptions, createLoginToken, LOGIN_COOKIE, LOGIN_TTL_SECONDS } from "@/lib/auth/session";
import { realMailboxPolicy } from "@/lib/email/policy";
import { GMAIL_SCOPE, GOOGLE_AUTH } from "@/lib/email/sources/gmail";

/** Optional Gmail connector: read-only consent with PKCE. Needs GOOGLE_CLIENT_ID, _SECRET and GOOGLE_REDIRECT_URI. */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(publicUrl(req, "/signin?returnTo=/inbox"));
  if (!realMailboxPolicy().allowed) return NextResponse.redirect(publicUrl(req, "/inbox?error=not_approved"));
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_REDIRECT_URI: redirectUri } = process.env;
  if (!clientId || !redirectUri || !process.env.GOOGLE_CLIENT_SECRET) return NextResponse.redirect(publicUrl(req, "/inbox?error=gmail_not_configured"));

  const crypto = new CryptoProvider();
  const { verifier, challenge } = await crypto.generatePkceCodes();
  const state = crypto.createNewGuid();
  const url = new URL(GOOGLE_AUTH);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: `openid email ${GMAIL_SCOPE}`,
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    login_hint: user.email,
  }).toString();
  const cfg = readAuthConfig();
  const res = NextResponse.redirect(url.href);
  res.cookies.set(LOGIN_COOKIE, createLoginToken(cfg, { state, verifier, returnTo: "/inbox" }), cookieOptions(cfg, LOGIN_TTL_SECONDS, "/api/connect"));
  return res;
}
