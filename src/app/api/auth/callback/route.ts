import { NextResponse, type NextRequest } from "next/server";
import { readAuthConfig, safeReturnTo } from "@/lib/auth/config";
import { completeSignIn, SignInError } from "@/lib/auth/entra";
import { publicUrl } from "@/lib/auth/http";
import { cookieOptions, createSessionToken, LOGIN_COOKIE, readLoginToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { upsertUser } from "@/lib/users";

export async function GET(req: NextRequest) {
  const cfg = readAuthConfig();
  const fail = (code: string) => {
    const res = NextResponse.redirect(publicUrl(req, `/signin?error=${code}`));
    res.cookies.delete({ name: LOGIN_COOKIE, path: "/api/auth" });
    return res;
  };
  if (!cfg.entra) return fail("entra_not_configured");

  const params = req.nextUrl.searchParams;
  if (params.get("error")) return fail("entra_declined");

  const login = readLoginToken(cfg, req.cookies.get(LOGIN_COOKIE)?.value);
  try {
    const identity = await completeSignIn(cfg.entra, { code: params.get("code"), returnedState: params.get("state"), login });
    const user = await upsertUser(getDb(), identity);
    const res = NextResponse.redirect(publicUrl(req, safeReturnTo(login?.returnTo)));
    res.cookies.set(SESSION_COOKIE, createSessionToken(cfg, user.id), cookieOptions(cfg, SESSION_TTL_SECONDS));
    res.cookies.delete({ name: LOGIN_COOKIE, path: "/api/auth" });
    return res;
  } catch (err) {
    if (!(err instanceof SignInError)) console.error("sign-in callback failed", err);
    return fail("sign_in_failed");
  }
}
