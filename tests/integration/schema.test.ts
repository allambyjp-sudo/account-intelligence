import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { createTestDb, hasTestDb, type TestDb } from "./db-helpers";

const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));

describe.skipIf(!hasTestDb)("schema: SQL migrations and the Drizzle mirror agree", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("has every table and column the mirror declares, and no extras", async () => {
    const { rows } = await t.pool.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1`,
      [t.schema],
    );
    const inDb = new Map<string, Map<string, boolean>>();
    for (const r of rows) {
      if (r.table_name === "schema_migrations") continue;
      if (!inDb.has(r.table_name)) inDb.set(r.table_name, new Map());
      inDb.get(r.table_name)!.set(r.column_name, r.is_nullable === "YES");
    }

    const mirrored = new Set<string>();
    for (const table of tables) {
      const cfg = getTableConfig(table);
      mirrored.add(cfg.name);
      const dbCols = inDb.get(cfg.name);
      expect(dbCols, `table ${cfg.name} missing from migrations`).toBeDefined();
      const mirrorCols = new Map(cfg.columns.map((c) => [c.name, !c.notNull]));
      expect([...mirrorCols.keys()].sort(), `columns of ${cfg.name}`).toEqual([...dbCols!.keys()].sort());
      for (const [col, nullable] of mirrorCols) {
        expect(nullable, `${cfg.name}.${col} nullability`).toBe(dbCols!.get(col));
      }
    }
    expect([...inDb.keys()].sort()).toEqual([...mirrored].sort());
  });

  it("CHECK constraint value lists match the enums in src/lib/domain/enums.ts", async () => {
    const { rows } = await t.pool.query<{ table_name: string; def: string }>(
      `SELECT rel.relname AS table_name, pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace ns ON ns.oid = rel.relnamespace
        WHERE ns.nspname = $1 AND con.contype = 'c'`,
      [t.schema],
    );
    // pg renders `col IN ('a','b')` as `(col = ANY (ARRAY['a'::text, 'b'::text]))`
    const listed = new Map<string, string[]>();
    for (const r of rows) {
      const m = /^CHECK \(\((\w+) = ANY \(ARRAY\[(.+)\]\)\)\)$/.exec(r.def);
      if (!m) continue;
      const values = [...m[2]!.matchAll(/'([^']*)'::text/g)].map((v) => v[1]!);
      listed.set(`${r.table_name}.${m[1]}`, values.sort());
    }

    let checked = 0;
    for (const table of tables) {
      const cfg = getTableConfig(table);
      for (const col of cfg.columns) {
        if (!col.enumValues?.length) continue;
        const key = `${cfg.name}.${col.name}`;
        expect(listed.get(key), `no CHECK list for ${key}`).toBeDefined();
        expect(listed.get(key), key).toEqual([...col.enumValues].sort());
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it("has pgvector available for account memory", async () => {
    const { rows } = await t.pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
    expect(rows).toHaveLength(1);
  });
});
