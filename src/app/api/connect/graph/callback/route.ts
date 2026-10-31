import { NextResponse, type NextRequest } from "next/server";
import { readAuthConfig } from "@/lib/auth/config";
import { getCurrentUser } from "@/lib/auth/current-user";
import { publicUrl } from "@/lib/auth/http";
import { LOGIN_COOKIE, readLoginToken } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { mailConnections } from "@/lib/db/schema";
import { GRAPH_MAIL_SCOPES, graphClient } from "@/lib/email/connections";
import { realMailboxPolicy } from "@/lib/email/policy";
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
  if (!user || !cfg.entra) return fail("connect_failed");
  if (!realMailboxPolicy().allowed) return fail("not_approved");
  const login = readLoginToken(cfg, req.cookies.get(LOGIN_COOKIE)?.value);
  const p = req.nextUrl.searchParams;
  if (!login || p.get("state") !== login.state || !p.get("code")) return fail("connect_failed");

  let cache = "";
  const client = graphClient(cfg.entra, null, async (c) => {
    cache = c;
  });
  try {
    const result = await client.acquireTokenByCode({
      code: p.get("code")!,
      codeVerifier: login.verifier,
      scopes: GRAPH_MAIL_SCOPES,
      redirectUri: new URL("/api/connect/graph/callback", cfg.entra.redirectUri).href,
    });
    const claims = (result.idTokenClaims ?? {}) as { tid?: string };
    // The mailbox must belong to the signed-in seller's own tenant.
    if (!result.account || claims.tid?.toLowerCase() !== cfg.entra.tenantId.toLowerCase()) return fail("connect_failed");
    const values = {
      mailbox: result.account.username,
      status: "active" as const,
      sealedTokens: sealTokens({ cache, homeAccountId: result.account.homeAccountId }),
      syncState: {},
      lastError: null,
    };
    const [conn] = await getDb()
      .insert(mailConnections)
      .values({ userId: user.id, provider: "graph", ...values })
      .onConflictDoUpdate({ target: [mailConnections.userId, mailConnections.provider], set: values })
      .returning();
    await (await getJobSender()).send(mailSyncJob, { connectionId: conn!.id }, { singletonKey: conn!.id });
    const res = NextResponse.redirect(publicUrl(req, "/inbox?connected=outlook"));
    res.cookies.delete({ name: LOGIN_COOKIE, path: "/api/connect" });
    return res;
  } catch (err) {
    console.error("Outlook connect failed", err);
    return fail("connect_failed");
  }
}
