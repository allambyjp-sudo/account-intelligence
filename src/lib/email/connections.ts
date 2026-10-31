import { ConfidentialClientApplication, type ICachePlugin, type TokenCacheContext } from "@azure/msal-node";
import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import type { EntraConfig } from "@/lib/auth/config";
import type { LLMProvider } from "@/lib/llm/types";
import { ingestMessages, type IngestResult } from "./ingest";
import { GmailMailSource, GOOGLE_TOKEN } from "./sources/gmail";
import { GraphMailSource } from "./sources/graph";
import { SyntheticMailSource } from "./sources/synthetic";
import { gmailTokens, graphTokens, sealTokens, unsealTokens } from "./tokens";
import type { MailSource } from "./types";

type Env = Record<string, string | undefined>;

export const GRAPH_MAIL_SCOPES = ["Mail.Read", "User.Read", "offline_access"];

/** MSAL client whose token cache lives (sealed) in the connection row. */
export function graphClient(cfg: EntraConfig, initialCache: string | null, onChange: (cache: string) => Promise<void>) {
  let current = initialCache;
  const plugin: ICachePlugin = {
    async beforeCacheAccess(ctx: TokenCacheContext) {
      if (current) ctx.tokenCache.deserialize(current);
    },
    async afterCacheAccess(ctx: TokenCacheContext) {
      if (!ctx.cacheHasChanged) return;
      current = ctx.tokenCache.serialize();
      await onChange(current);
    },
  };
  return new ConfidentialClientApplication({
    auth: { clientId: cfg.clientId, authority: `https://login.microsoftonline.com/${cfg.tenantId}`, clientSecret: cfg.clientSecret },
    cache: { cachePlugin: plugin },
  });
}

export function graphAccessToken(db: Db, cfg: EntraConfig, conn: t.MailConnection, env: Env): () => Promise<string> {
  const tokens = unsealTokens(conn.sealedTokens, graphTokens, env);
  if (!tokens) throw new Error("This Outlook connection's tokens can't be read. Reconnect the mailbox.");
  const client = graphClient(cfg, tokens.cache, async (cache) => {
    await db.update(t.mailConnections).set({ sealedTokens: sealTokens({ cache, homeAccountId: tokens.homeAccountId }, env) }).where(eq(t.mailConnections.id, conn.id));
  });
  return async () => {
    const account = await client.getTokenCache().getAccountByHomeId(tokens.homeAccountId);
    if (!account) throw new Error("The Outlook account isn't in the token cache. Reconnect the mailbox.");
    const res = await client.acquireTokenSilent({ account, scopes: ["Mail.Read"] });
    return res.accessToken;
  };
}

export function gmailAccessToken(db: Db, conn: t.MailConnection, env: Env, fetchImpl: typeof fetch = fetch): () => Promise<string> {
  let tokens = unsealTokens(conn.sealedTokens, gmailTokens, env);
  if (!tokens) throw new Error("This Gmail connection's tokens can't be read. Reconnect the mailbox.");
  return async () => {
    if (tokens!.accessToken && tokens!.expiresAt && tokens!.expiresAt > Date.now() + 60_000) return tokens!.accessToken;
    const res = await fetchImpl(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens!.refreshToken, client_id: env.GOOGLE_CLIENT_ID ?? "", client_secret: env.GOOGLE_CLIENT_SECRET ?? "" }),
    });
    if (!res.ok) throw new Error(`Gmail token refresh failed: ${res.status}. Reconnect the mailbox.`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    tokens = { ...tokens!, accessToken: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    await db.update(t.mailConnections).set({ sealedTokens: sealTokens(tokens, env) }).where(eq(t.mailConnections.id, conn.id));
    return body.access_token;
  };
}

export function sourceFor(db: Db, conn: t.MailConnection, env: Env, entra: EntraConfig | null): MailSource {
  if (conn.provider === "synthetic") return new SyntheticMailSource();
  if (conn.provider === "graph") {
    if (!entra) throw new Error("Entra isn't configured, so Outlook can't be read.");
    return new GraphMailSource(graphAccessToken(db, entra, conn, env));
  }
  return new GmailMailSource(gmailAccessToken(db, conn, env));
}

/** One sync of one mailbox: fetch changes, ingest them, save the new sync state. */
export async function syncConnection(db: Db, llm: LLMProvider, connectionId: string, deps: { env: Env; entra: EntraConfig | null; source?: MailSource }): Promise<IngestResult | null> {
  const [conn] = await db.select().from(t.mailConnections).where(eq(t.mailConnections.id, connectionId)).limit(1);
  if (!conn || conn.status === "disconnected") return null;
  try {
    const source = deps.source ?? sourceFor(db, conn, deps.env, deps.entra);
    const { messages, state } = await source.fetchChanges(conn.syncState);
    const result = await ingestMessages(db, llm, { userId: conn.userId, provider: conn.provider, messages, env: deps.env });
    await db.update(t.mailConnections).set({ syncState: state, lastSyncedAt: new Date(), lastError: null, status: "active" }).where(eq(t.mailConnections.id, conn.id));
    return result;
  } catch (err) {
    await db
      .update(t.mailConnections)
      .set({ status: "error", lastError: err instanceof Error ? err.message : String(err) })
      .where(eq(t.mailConnections.id, conn.id));
    throw err;
  }
}
