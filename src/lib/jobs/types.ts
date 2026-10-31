import type { z } from "zod";
import type { Db } from "@/lib/db/client";

export interface JobContext {
  db: Db;
  workerId: string;
  log(message: string): void;
  /** Lets a job queue follow-up work (e.g. research finishing queues an advisor refresh). */
  queue: Pick<JobQueue, "send">;
}

/**
 * A named background job with a validated payload. Research runs, source polling, signal
 * classification and email sync are all jobs; the worker process runs them.
 */
export interface JobDefinition<T> {
  /** Letters, digits and hyphens: "research-account", "poll-news". */
  name: string;
  schema: z.ZodType<T>;
  /** Cron expression in APP_TIMEZONE (Australia/Melbourne by default). */
  cron?: string;
  retryLimit?: number;
  handle(data: T, ctx: JobContext): Promise<void>;
}

export interface JobQueue {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Start working this job (and schedule it, if it has a cron). */
  register<T>(def: JobDefinition<T>, ctx: JobContext): Promise<void>;
  /** singletonKey: at most one queued job per key (e.g. one advisor refresh per account). */
  send<T>(def: JobDefinition<T>, data: T, opts?: { singletonKey?: string; startAfterSeconds?: number }): Promise<string | null>;
}

export const defineJob = <T>(def: JobDefinition<T>): JobDefinition<T> => {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(def.name)) throw new Error(`Job name "${def.name}" must be kebab-case`);
  return def;
};
