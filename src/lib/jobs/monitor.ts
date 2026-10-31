import { z } from "zod";
import { createFetcher } from "@/lib/http";
import { getLLMProvider } from "@/lib/llm/registry";
import { matchAdvisories } from "@/lib/monitor/advisories";
import { accountsWithPendingSignals, classifySignals, type ClassifyResult } from "@/lib/monitor/classify";
import { accountsToMonitor, monitorAccount } from "@/lib/monitor/poll";
import { raiseQuietAlerts } from "@/lib/monitor/quiet";
import { defineJob, type JobContext } from "./types";

/**
 * Live monitoring (brief, section 4.4). Schedules are in APP_TIMEZONE and sit off the hour so they
 * don't collide with everyone else's cron jobs.
 */

/** Called after each classification batch. The advisor module registers memory sync and advisor refresh. */
export const afterClassifyHooks: Array<(accountId: string, result: ClassifyResult, ctx: JobContext) => Promise<void>> = [];

export const classifySignalsJob = defineJob({
  name: "classify-signals",
  schema: z.object({ accountId: z.uuid() }),
  retryLimit: 1,
  async handle({ accountId }, ctx) {
    // Batches of 15: loop until the account's queue is empty, capped so one account can't hog the worker.
    for (let i = 0; i < 5; i++) {
      const res = await classifySignals(ctx.db, getLLMProvider(), accountId);
      if (res.classified) for (const hook of afterClassifyHooks) await hook(accountId, res, ctx);
      if (res.classified < 15) break;
    }
  },
});

export const monitorAccountJob = defineJob({
  name: "monitor-account",
  schema: z.object({ accountId: z.uuid() }),
  retryLimit: 1,
  async handle({ accountId }, ctx) {
    const res = await monitorAccount({ db: ctx.db, fetcher: createFetcher(ctx.db), env: process.env }, accountId);
    if (Object.keys(res.failed).length) ctx.log(`monitor ${accountId}: ${JSON.stringify(res.failed)}`);
    if (res.newSignals) await ctx.queue.send(classifySignalsJob, { accountId }, { singletonKey: accountId });
  },
});

export const monitorSweepJob = defineJob({
  name: "monitor-sweep",
  schema: z.object({}).loose(),
  cron: "17 */2 * * *",
  retryLimit: 0,
  async handle(_data, ctx) {
    for (const accountId of await accountsToMonitor(ctx.db)) {
      await ctx.queue.send(monitorAccountJob, { accountId }, { singletonKey: accountId });
    }
  },
});

export const classifySweepJob = defineJob({
  name: "classify-sweep",
  schema: z.object({}).loose(),
  cron: "29 * * * *",
  retryLimit: 0,
  async handle(_data, ctx) {
    for (const accountId of await accountsWithPendingSignals(ctx.db)) {
      await ctx.queue.send(classifySignalsJob, { accountId }, { singletonKey: accountId });
    }
  },
});

export const advisoriesJob = defineJob({
  name: "match-advisories",
  schema: z.object({}).loose(),
  cron: "43 7 * * *",
  retryLimit: 1,
  async handle(_data, ctx) {
    const res = await matchAdvisories(ctx.db, createFetcher(ctx.db), process.env);
    ctx.log(`advisories: ${res.advisories} read, ${res.signals} account signals`);
  },
});

export const quietCheckJob = defineJob({
  name: "quiet-check",
  schema: z.object({}).loose(),
  cron: "11 8 * * *",
  retryLimit: 1,
  async handle(_data, ctx) {
    const n = await raiseQuietAlerts(ctx.db);
    if (n) ctx.log(`quiet-customer alerts raised: ${n}`);
  },
});
