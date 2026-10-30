import { NextResponse, type NextRequest } from "next/server";
import { readAuthConfig, safeReturnTo } from "@/lib/auth/config";
import { isSameOrigin, publicUrl } from "@/lib/auth/http";
import { cookieOptions, createSessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { DEV_IDENTITY, upsertUser } from "@/lib/users";

/** Local development sign-in. readAuthConfig refuses AUTH_DEV_BYPASS in production. */
export async function POST(req: NextRequest) {
  const cfg = readAuthConfig();
  if (!cfg.devBypass || cfg.isProduction) return new NextResponse("Not found", { status: 404 });
  if (!isSameOrigin(req)) return new NextResponse("Forbidden", { status: 403 });

  const form = await req.formData();
  const returnTo = safeReturnTo(typeof form.get("returnTo") === "string" ? (form.get("returnTo") as string) : null);
  const user = await upsertUser(getDb(), DEV_IDENTITY);
  const res = NextResponse.redirect(publicUrl(req, returnTo), 303);
  res.cookies.set(SESSION_COOKIE, createSessionToken(cfg, user.id), cookieOptions(cfg, SESSION_TTL_SECONDS));
  return res;
}
