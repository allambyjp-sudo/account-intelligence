import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgCacheStore } from "@/lib/http/pg-cache";
import { createTestDb, hasTestDb, type TestDb } from "./db-helpers";

describe.skipIf(!hasTestDb)("PgCacheStore", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("round-trips binary bodies and overwrites on revalidation", async () => {
    const store = new PgCacheStore(t.db);
    const body = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]); // a PDF-ish binary prefix
    const entry = {
      url: "https://example.com/report.pdf",
      status: 200,
      headers: { "content-type": "application/pdf" },
      body,
      etag: '"v1"',
      lastModified: null,
      fetchedAt: new Date("2026-10-30T00:00:00Z"),
      expiresAt: new Date("2026-10-30T06:00:00Z"),
    };
    await store.set("GET https://example.com/report.pdf", entry);
    const got = await store.get("GET https://example.com/report.pdf");
    expect(got?.body.equals(body)).toBe(true);
    expect(got?.headers).toEqual({ "content-type": "application/pdf" });

    await store.set("GET https://example.com/report.pdf", { ...entry, expiresAt: new Date("2026-10-31T00:00:00Z") });
    expect((await store.get("GET https://example.com/report.pdf"))?.expiresAt.toISOString()).toBe("2026-10-31T00:00:00.000Z");
    expect(await store.get("GET https://example.com/missing")).toBeNull();
  });
});
