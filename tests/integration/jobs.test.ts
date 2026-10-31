import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { workerHeartbeats } from "@/lib/db/schema";
import { heartbeatJob } from "@/lib/jobs/heartbeat";
import { defineJob } from "@/lib/jobs/types";
import { PgBossQueue } from "@/lib/jobs/pgboss";
import { createTestDb, hasTestDb, TEST_DATABASE_URL, type TestDb } from "./db-helpers";

describe.skipIf(!hasTestDb)("PgBossQueue", () => {
  let t: TestDb;
  let queue: PgBossQueue;
  const bossSchema = `pgboss_${randomBytes(4).toString("hex")}`;

  beforeAll(async () => {
    t = await createTestDb();
    queue = new PgBossQueue({ connectionString: TEST_DATABASE_URL!, schema: bossSchema });
    await queue.start();
  });
  afterAll(async () => {
    await queue?.stop();
    const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
    await admin.end();
    await t?.drop();
  });

  it("runs a queued heartbeat job that writes to the database", async () => {
    await queue.register(heartbeatJob, { db: t.db, workerId: "test-worker", log: () => {}, queue });
    expect(await queue.send(heartbeatJob, {})).toBeTruthy();

    const deadline = Date.now() + 15_000;
    let rows: Array<typeof workerHeartbeats.$inferSelect> = [];
    while (Date.now() < deadline) {
      rows = await t.db.select().from(workerHeartbeats);
      if (rows.length) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workerId).toBe("test-worker");
  });

  it("validates payloads before they reach the queue", async () => {
    const strict = defineJob({ name: "test-strict", schema: z.object({ accountId: z.uuid() }), handle: async () => {} });
    await expect(queue.send(strict, { accountId: "not-a-uuid" })).rejects.toThrow();
  });
});
