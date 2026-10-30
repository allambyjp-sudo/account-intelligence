import { hostname } from "node:os";
import { connect } from "@/lib/db/client";
import { PgBossQueue } from "@/lib/jobs/pgboss";
import { ALL_JOBS } from "@/lib/jobs/registry";
import { loadEnv } from "./env";

/** The background worker: research, polling and email jobs run here, never in the web process. */
async function main() {
  loadEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const { db, pool } = connect();
  const workerId = `${hostname()}:${process.pid}`;
  const queue = new PgBossQueue({ connectionString: url, timezone: process.env.APP_TIMEZONE });
  await queue.start();
  const ctx = { db, workerId, log: (m: string) => console.log(`[${workerId}] ${m}`) };
  for (const job of ALL_JOBS) await queue.register(job, ctx);
  console.log(`worker ${workerId} running ${ALL_JOBS.map((j) => j.name).join(", ")}`);

  const shutdown = async (signal: string) => {
    console.log(`${signal}: stopping worker`);
    await queue.stop();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
