import { z } from "zod";
import { refreshAdvisor } from "@/lib/advisor/advisor";
import { getEmbeddingProvider, getLLMProvider } from "@/lib/llm/registry";
import { syncAccountMemory } from "@/lib/memory/sync";
import { afterClassifyHooks } from "./monitor";
import { defineJob, type JobContext } from "./types";

export const memorySyncJob = defineJob({
  name: "memory-sync",
  schema: z.object({ accountId: z.uuid() }),
  retryLimit: 2,
  async handle({ accountId }, ctx) {
    const n = await syncAccountMemory(ctx.db, getEmbeddingProvider(), accountId);
    if (n) ctx.log(`memory ${accountId}: ${n} chunks indexed`);
  },
});

export const advisorRefreshJob = defineJob({
  name: "advisor-refresh",
  schema: z.object({ accountId: z.uuid(), force: z.boolean().optional() }),
  retryLimit: 1,
  async handle({ accountId, force }, ctx) {
    // Memory first, so the advisor can retrieve what just arrived.
    await syncAccountMemory(ctx.db, getEmbeddingProvider(), accountId).catch((err: unknown) => ctx.log(`memory sync skipped: ${String(err)}`));
    const res = await refreshAdvisor(ctx.db, getLLMProvider(), getEmbeddingProvider(), accountId, { force });
    ctx.log(`advisor ${accountId}: ${res.status} (${res.created} items${res.dropped ? `, ${res.dropped} without evidence dropped` : ""})`);
  },
});

/** Debounced: several triggers in a minute become one refresh. */
export async function queueAdvisorRefresh(queue: Pick<JobContext["queue"], "send">, accountId: string, force = false) {
  await queue.send(advisorRefreshJob, { accountId, force }, { singletonKey: accountId, startAfterSeconds: 60 });
}

afterClassifyHooks.push(async (accountId, result, ctx) => {
  await ctx.queue.send(memorySyncJob, { accountId }, { singletonKey: accountId, startAfterSeconds: 30 });
  // The advisor refreshes when something meaningful changes: a high-importance signal.
  if (result.high.length) await queueAdvisorRefresh(ctx.queue, accountId);
});
