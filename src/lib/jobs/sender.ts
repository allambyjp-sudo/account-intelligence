import { PgBossQueue } from "./pgboss";

let sender: PgBossQueue | undefined;
let starting: Promise<void> | undefined;

/** The web app's handle for queueing jobs. The worker process runs them. */
export async function getJobSender(): Promise<PgBossQueue> {
  if (!sender) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set.");
    sender = new PgBossQueue({ connectionString: url, role: "sender", timezone: process.env.APP_TIMEZONE });
    starting = sender.start();
  }
  await starting;
  return sender;
}
