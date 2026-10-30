import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { connect, type Db } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";

/**
 * Integration suites run only when TEST_DATABASE_URL points at a Postgres with pgvector
 * (docker compose gives you one; CI provides one). Each suite gets a throwaway schema.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const hasTestDb = Boolean(TEST_DATABASE_URL);

export interface TestDb {
  db: Db;
  pool: Pool;
  schema: string;
  url: string;
  drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is not set");
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const { db, pool } = connect({ url: TEST_DATABASE_URL, searchPath: schema, max: 4 });
  await runMigrations(pool);
  return {
    db,
    pool,
    schema,
    url: TEST_DATABASE_URL,
    async drop() {
      await pool.end();
      const cleanup = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
      await cleanup.query(`DROP SCHEMA ${schema} CASCADE`);
      await cleanup.end();
    },
  };
}
