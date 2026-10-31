import { z } from "zod";
import { createFetcher } from "@/lib/http";
import { resolveIntake } from "@/lib/intake/intake";
import { getLLMProvider } from "@/lib/llm/registry";
import { runResearch } from "@/lib/research/run";
import { queueAdvisorRefresh } from "./advisor";
import { defineJob } from "./types";

export const resolveIntakeJob = defineJob({
  name: "resolve-intake",
  schema: z.object({ intakeId: z.uuid() }),
  retryLimit: 1,
  async handle({ intakeId }, ctx) {
    await resolveIntake(ctx.db, createFetcher(ctx.db), process.env, intakeId);
  },
});

export const researchAccountJob = defineJob({
  name: "research-account",
  schema: z.object({ runId: z.uuid() }),
  // Research spends model tokens: never retry automatically. The seller can re-run it.
  retryLimit: 0,
  async handle({ runId }, ctx) {
    const run = await runResearch({ db: ctx.db, llm: getLLMProvider(), fetcher: createFetcher(ctx.db), env: process.env }, runId);
    ctx.log(`research ${runId} for ${run.accountId}: ${run.status}`);
    if (run.status === "succeeded" || run.status === "partial") await queueAdvisorRefresh(ctx.queue, run.accountId);
  },
});
