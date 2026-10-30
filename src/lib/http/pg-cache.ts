import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { httpCache } from "@/lib/db/schema";
import type { CachedResponse, HttpCacheStore } from "./cache";

/** The shared response cache, in Postgres so the web app and the worker see the same entries. */
export class PgCacheStore implements HttpCacheStore {
  constructor(private readonly db: Db) {}

  async get(key: string): Promise<CachedResponse | null> {
    const [row] = await this.db.select().from(httpCache).where(eq(httpCache.cacheKey, key)).limit(1);
    if (!row) return null;
    return {
      url: row.url,
      status: row.status,
      headers: row.headers,
      body: row.body,
      etag: row.etag,
      lastModified: row.lastModified,
      fetchedAt: row.fetchedAt,
      expiresAt: row.expiresAt,
    };
  }

  async set(key: string, v: CachedResponse): Promise<void> {
    const row = { ...v, cacheKey: key };
    await this.db
      .insert(httpCache)
      .values(row)
      .onConflictDoUpdate({ target: httpCache.cacheKey, set: row });
  }
}
