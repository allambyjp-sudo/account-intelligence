import { PgBoss } from "pg-boss";
import type { JobContext, JobDefinition, JobQueue } from "./types";

export interface PgBossQueueOptions {
  connectionString: string;
  /** Postgres schema pg-boss keeps its tables in. */
  schema?: string;
  timezone?: string;
  /** "sender" is for the web app: it queues jobs but never runs maintenance or schedules. */
  role?: "worker" | "sender";
}

/**
 * JobQueue on pg-boss: the queue lives in the same Postgres as everything else, so there's no
 * Redis to host or put through IT review. Swap in BullMQ behind the same interface if volume
 * ever needs it.
 */
export class PgBossQueue implements JobQueue {
  private readonly boss: PgBoss;
  private readonly timezone: string;
  private readonly created = new Set<string>();

  constructor(opts: PgBossQueueOptions) {
    const sender = opts.role === "sender";
    this.boss = new PgBoss({
      connectionString: opts.connectionString,
      schema: opts.schema ?? "pgboss",
      ...(sender ? { supervise: false, schedule: false, max: 2 } : {}),
    });
    this.boss.on("error", (err) => console.error("[jobs] pg-boss error", err));
    this.timezone = opts.timezone ?? "Australia/Melbourne";
  }

  async start() {
    await this.boss.start();
  }

  async stop() {
    await this.boss.stop({ graceful: true });
  }

  private async ensureQueue(def: JobDefinition<unknown>) {
    if (this.created.has(def.name)) return;
    await this.boss.createQueue(def.name, { retryLimit: def.retryLimit ?? 3 });
    this.created.add(def.name);
  }

  async register<T>(def: JobDefinition<T>, ctx: JobContext) {
    await this.ensureQueue(def as JobDefinition<unknown>);
    await this.boss.work<unknown>(def.name, async (jobs) => {
      for (const job of jobs) {
        const parsed = def.schema.safeParse(job.data);
        if (!parsed.success) throw new Error(`Job ${def.name} ${job.id} has an invalid payload: ${parsed.error.message}`);
        await def.handle(parsed.data, ctx);
      }
    });
    if (def.cron) await this.boss.schedule(def.name, def.cron, {}, { tz: this.timezone });
  }

  async send<T>(def: JobDefinition<T>, data: T, opts: { singletonKey?: string; startAfterSeconds?: number } = {}) {
    const payload = def.schema.parse(data);
    await this.ensureQueue(def as JobDefinition<unknown>);
    return this.boss.send(def.name, payload as object, {
      ...(opts.singletonKey ? { singletonKey: opts.singletonKey } : {}),
      ...(opts.startAfterSeconds ? { startAfter: opts.startAfterSeconds } : {}),
    });
  }
}
