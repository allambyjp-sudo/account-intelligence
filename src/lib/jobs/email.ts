import { and, eq, isNotNull, lt, or, isNull } from "drizzle-orm";
import { z } from "zod";
import { readAuthConfig } from "@/lib/auth/config";
import { mailConnections } from "@/lib/db/schema";
import { graphAccessToken, syncConnection } from "@/lib/email/connections";
import { createGraphSubscription, renewGraphSubscription } from "@/lib/email/sources/graph";
import { getLLMProvider } from "@/lib/llm/registry";
import { advisorRefreshJob, memorySyncJob } from "./advisor";
import { defineJob } from "./types";

const entra = () => {
  try {
    return readAuthConfig().entra;
  } catch {
    return null;
  }
};

export const mailSyncJob = defineJob({
  name: "mail-sync",
  schema: z.object({ connectionId: z.uuid() }),
  retryLimit: 1,
  async handle({ connectionId }, ctx) {
    const res = await syncConnection(ctx.db, getLLMProvider(), connectionId, { env: process.env, entra: entra() });
    if (!res) return;
    ctx.log(`mail ${connectionId}: ${res.messages} messages, ${res.threadsStored} threads stored, ${res.skipped} skipped, ${res.unmatched} unmatched, ${res.pending} to confirm`);
    for (const accountId of res.accountsTouched) await ctx.queue.send(memorySyncJob, { accountId }, { singletonKey: accountId, startAfterSeconds: 10 });
    // Quotes, renewals, deadlines and requests are meaningful changes for the advisor.
    for (const accountId of res.meaningful) await ctx.queue.send(advisorRefreshJob, { accountId }, { singletonKey: accountId, startAfterSeconds: 60 });
  },
});

export const mailSyncSweepJob = defineJob({
  name: "mail-sync-sweep",
  schema: z.object({}).loose(),
  cron: "*/15 * * * *",
  retryLimit: 0,
  async handle(_data, ctx) {
    const conns = await ctx.db.select({ id: mailConnections.id }).from(mailConnections).where(eq(mailConnections.status, "active"));
    for (const c of conns) await ctx.queue.send(mailSyncJob, { connectionId: c.id }, { singletonKey: c.id });
  },
});

/** Keeps Outlook change notifications alive, when the app has a public HTTPS address for them. */
export const graphSubscriptionsJob = defineJob({
  name: "graph-subscriptions",
  schema: z.object({}).loose(),
  cron: "37 */12 * * *",
  retryLimit: 1,
  async handle(_data, ctx) {
    const base = process.env.PUBLIC_BASE_URL;
    const cfg = entra();
    if (!base?.startsWith("https://") || !cfg) return; // without a public URL, the 15-minute sweep is the fallback
    const soon = new Date(Date.now() + 24 * 3_600_000);
    const due = await ctx.db
      .select()
      .from(mailConnections)
      .where(and(eq(mailConnections.provider, "graph"), eq(mailConnections.status, "active"), or(isNull(mailConnections.subscriptionId), and(isNotNull(mailConnections.subscriptionExpiresAt), lt(mailConnections.subscriptionExpiresAt, soon)))));
    for (const conn of due) {
      try {
        const token = await graphAccessToken(ctx.db, cfg, conn, process.env)();
        if (conn.subscriptionId) {
          const expiresAt = await renewGraphSubscription(token, conn.subscriptionId);
          await ctx.db.update(mailConnections).set({ subscriptionExpiresAt: expiresAt }).where(eq(mailConnections.id, conn.id));
        } else {
          const sub = await createGraphSubscription(token, `${base.replace(/\/$/, "")}/api/graph/notifications`, conn.clientState);
          await ctx.db.update(mailConnections).set({ subscriptionId: sub.id, subscriptionExpiresAt: sub.expiresAt }).where(eq(mailConnections.id, conn.id));
        }
      } catch (err) {
        ctx.log(`graph subscription for ${conn.id}: ${String(err)}`);
        await ctx.db.update(mailConnections).set({ subscriptionId: null, subscriptionExpiresAt: null }).where(eq(mailConnections.id, conn.id));
      }
    }
  },
});
