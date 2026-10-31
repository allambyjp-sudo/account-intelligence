import { desc, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { sources, type Source } from "@/lib/db/schema";
import { capText, sourceRecordSchema, type SourceRecord } from "./types";

/** How much of each source's text we keep for the model. Reports are long; the cap keeps rows sane. */
export const BODY_TEXT_CAP = 200_000;

/**
 * Saves a record as a source row, or refreshes the existing one for the same URL (and content
 * version). Returns the row, so claims can cite it.
 */
export async function upsertSource(db: Db, record: SourceRecord): Promise<Source> {
  const r = sourceRecordSchema.parse(record);
  const values = {
    url: r.url,
    title: r.title,
    publisher: r.publisher,
    adapter: r.adapter,
    sourceType: r.sourceType,
    publishedAt: r.publishedAt,
    retrievedAt: r.retrievedAt,
    contentHash: r.contentHash ?? null,
    excerpt: r.text.slice(0, 500),
    bodyText: capText(r.text, BODY_TEXT_CAP),
  };
  const [row] = await db
    .insert(sources)
    .values(values)
    .onConflictDoUpdate({
      target: [sources.url, sources.contentHash],
      set: {
        title: values.title,
        publisher: values.publisher,
        publishedAt: sql`coalesce(${sources.publishedAt}, excluded.published_at)`,
        retrievedAt: values.retrievedAt,
        excerpt: values.excerpt,
        bodyText: values.bodyText,
      },
    })
    .returning();
  return row!;
}

/** The newest stored version of a URL, for change detection. */
export async function latestVersion(db: Db, url: string): Promise<Source | null> {
  const [row] = await db.select().from(sources).where(eq(sources.url, url)).orderBy(desc(sources.retrievedAt)).limit(1);
  return row ?? null;
}
