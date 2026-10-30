import type { z } from "zod";
import type { Db } from "@/lib/db/client";

export interface JobContext {
  db: Db;
  workerId: string;
  log(message: string): void;
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
  send<T>(def: JobDefinition<T>, data: T): Promise<string | null>;
}

export const defineJob = <T>(def: JobDefinition<T>): JobDefinition<T> => {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(def.name)) throw new Error(`Job name "${def.name}" must be kebab-case`);
  return def;
};
