import { NextResponse, type NextRequest } from "next/server";
import { readAuthConfig } from "@/lib/auth/config";
import { getCurrentUser } from "@/lib/auth/current-user";
import { publicUrl } from "@/lib/auth/http";
import { LOGIN_COOKIE, readLoginToken } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { mailConnections } from "@/lib/db/schema";
import { realMailboxPolicy } from "@/lib/email/policy";
import { GOOGLE_TOKEN } from "@/lib/email/sources/gmail";
import { sealTokens } from "@/lib/email/tokens";
import { mailSyncJob } from "@/lib/jobs/email";
import { getJobSender } from "@/lib/jobs/sender";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const cfg = readAuthConfig();
  const fail = (code: string) => {
    const res = NextResponse.redirect(publicUrl(req, `/inbox?error=${code}`));
    res.cookies.delete({ name: LOGIN_COOKIE, path: "/api/connect" });
    return res;
  };
  if (!user || !realMailboxPolicy().allowed) return fail("not_approved");
  const login = readLoginToken(cfg, req.cookies.get(LOGIN_COOKIE)?.value);
  const p = req.nextUrl.searchParams;
  if (!login || p.get("state") !== login.state || !p.get("code")) return fail("connect_failed");

  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: p.get("code")!,
      code_verifier: login.verifier,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: process.env.GOOGLE_REDIRECT_URI ?? "",
    }),
  });
  if (!res.ok) return fail("connect_failed");
  const body = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; id_token?: string };
  if (!body.refresh_token) return fail("connect_failed");
  const email = body.id_token ? (JSON.parse(Buffer.from(body.id_token.split(".")[1]!, "base64url").toString()) as { email?: string }).email : undefined;
  const values = {
    mailbox: email ?? "Gmail",
    status: "active" as const,
    sealedTokens: sealTokens({ refreshToken: body.refresh_token, accessToken: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 }),
    syncState: {},
    lastError: null,
  };
  const [conn] = await getDb()
    .insert(mailConnections)
    .values({ userId: user.id, provider: "gmail", ...values })
    .onConflictDoUpdate({ target: [mailConnections.userId, mailConnections.provider], set: values })
    .returning();
  await (await getJobSender()).send(mailSyncJob, { connectionId: conn!.id }, { singletonKey: conn!.id });
  const out = NextResponse.redirect(publicUrl(req, "/inbox?connected=gmail"));
  out.cookies.delete({ name: LOGIN_COOKIE, path: "/api/connect" });
  return out;
}
