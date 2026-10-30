import { sql } from "drizzle-orm";
import { z } from "zod";
import { workerHeartbeats } from "@/lib/db/schema";
import { defineJob } from "./types";

export const WORKER_VERSION = "0.1.0";

/** Proves the worker and the scheduler are alive. The UI shows "worker last seen". */
export const heartbeatJob = defineJob({
  name: "system-heartbeat",
  schema: z.object({}).loose(),
  cron: "* * * * *",
  retryLimit: 0,
  async handle(_data, ctx) {
    const now = new Date();
    await ctx.db
      .insert(workerHeartbeats)
      .values({ workerId: ctx.workerId, startedAt: now, lastBeatAt: now, version: WORKER_VERSION })
      .onConflictDoUpdate({ target: workerHeartbeats.workerId, set: { lastBeatAt: sql`now()`, version: WORKER_VERSION } });
  },
});
