import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export interface ConnectOptions {
  url?: string;
  /** Postgres schema to work in. Integration tests use a throwaway one per suite. */
  searchPath?: string;
  max?: number;
}

export function connect(opts: ConnectOptions = {}) {
  const url = opts.url ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  const pool = new Pool({
    connectionString: url,
    max: opts.max ?? 5,
    ...(opts.searchPath ? { options: `-c search_path=${opts.searchPath},public` } : {}),
  });
  return { db: drizzle(pool, { schema }), pool };
}

export type Db = ReturnType<typeof connect>["db"];

let shared: ReturnType<typeof connect> | undefined;

/** One pool per server process. */
export function getDb(): Db {
  shared ??= connect();
  return shared.db;
}
