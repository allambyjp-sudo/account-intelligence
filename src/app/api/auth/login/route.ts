import { NextResponse, type NextRequest } from "next/server";
import { readAuthConfig, safeReturnTo } from "@/lib/auth/config";
import { beginSignIn } from "@/lib/auth/entra";
import { publicUrl } from "@/lib/auth/http";
import { cookieOptions, createLoginToken, LOGIN_COOKIE, LOGIN_TTL_SECONDS } from "@/lib/auth/session";

export async function GET(req: NextRequest) {
  const cfg = readAuthConfig();
  if (!cfg.entra) {
    return NextResponse.redirect(publicUrl(req, "/signin?error=entra_not_configured"));
  }
  const returnTo = safeReturnTo(req.nextUrl.searchParams.get("returnTo"));
  const { url, state } = await beginSignIn(cfg.entra, returnTo);
  const res = NextResponse.redirect(url);
  res.cookies.set(LOGIN_COOKIE, createLoginToken(cfg, state), cookieOptions(cfg, LOGIN_TTL_SECONDS, "/api/auth"));
  return res;
}
