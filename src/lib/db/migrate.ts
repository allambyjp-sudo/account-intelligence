import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";

export const MIGRATIONS_DIR = path.join(process.cwd(), "db/migrations");

/** Any constant: identifies this app's migration lock among Postgres advisory locks. */
const MIGRATION_LOCK = 4_720_311;

/**
 * Applies db/migrations/*.sql in name order, once each, inside a transaction per file. A
 * transaction-scoped advisory lock serialises concurrent runners (two app instances starting, or
 * parallel test suites), so database-wide steps like CREATE EXTENSION never race.
 */
export async function runMigrations(pool: Pool, log: (msg: string) => void = () => {}): Promise<string[]> {
  const client = await pool.connect();
  const appliedNow: string[] = [];
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const applied = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
        // Another runner may have applied this file while we waited for the lock.
        const done = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
        if (done.rowCount) {
          await client.query("COMMIT");
          continue;
        }
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        appliedNow.push(file);
        log(`applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return appliedNow;
  } finally {
    client.release();
  }
}
