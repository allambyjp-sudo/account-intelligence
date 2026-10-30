import { PgBoss } from "pg-boss";
import type { JobContext, JobDefinition, JobQueue } from "./types";

export interface PgBossQueueOptions {
  connectionString: string;
  /** Postgres schema pg-boss keeps its tables in. */
  schema?: string;
  timezone?: string;
}

/**
 * JobQueue on pg-boss: the queue lives in the same Postgres as everything else, so there's no
 * Redis to host or put through IT review. Swap in BullMQ behind the same interface if volume
 * ever needs it.
 */
export class PgBossQueue implements JobQueue {
  private readonly boss: PgBoss;
  private readonly timezone: string;

  constructor(opts: PgBossQueueOptions) {
    this.boss = new PgBoss({ connectionString: opts.connectionString, schema: opts.schema ?? "pgboss" });
    this.boss.on("error", (err) => console.error("[jobs] pg-boss error", err));
    this.timezone = opts.timezone ?? "Australia/Melbourne";
  }

  async start() {
    await this.boss.start();
  }

  async stop() {
    await this.boss.stop({ graceful: true });
  }

  async register<T>(def: JobDefinition<T>, ctx: JobContext) {
    await this.boss.createQueue(def.name, { retryLimit: def.retryLimit ?? 3 });
    await this.boss.work<unknown>(def.name, async (jobs) => {
      for (const job of jobs) {
        const parsed = def.schema.safeParse(job.data);
        if (!parsed.success) throw new Error(`Job ${def.name} ${job.id} has an invalid payload: ${parsed.error.message}`);
        await def.handle(parsed.data, ctx);
      }
    });
    if (def.cron) await this.boss.schedule(def.name, def.cron, {}, { tz: this.timezone });
  }

  async send<T>(def: JobDefinition<T>, data: T) {
    const payload = def.schema.parse(data);
    return this.boss.send(def.name, payload as object);
  }
}
