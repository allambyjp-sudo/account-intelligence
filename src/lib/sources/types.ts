import { z } from "zod";
import { SOURCE_TYPE } from "@/lib/domain/enums";
import type { PoliteFetcher } from "@/lib/http";

/**
 * What every source adapter returns (brief, section 4.3): source, url, date, type, entities, text.
 * Records become rows in `sources`, and the claims extracted from them cite those rows.
 */
export const sourceRecordSchema = z.object({
  /** The adapter that produced the record, e.g. "asx_announcements". */
  adapter: z.string().regex(/^[a-z0-9_]+$/),
  sourceType: z.enum(SOURCE_TYPE),
  url: z.url({ protocol: /^https?$/ }),
  title: z.string().nullable(),
  publisher: z.string().nullable(),
  /** When the source says it was published. Null when it doesn't say. */
  publishedAt: z.date().nullable(),
  retrievedAt: z.date(),
  /** Organisations the record mentions, with whatever identifiers it gives. */
  entities: z.array(
    z.object({
      name: z.string().min(1),
      abn: z.string().regex(/^\d{11}$/).optional(),
      nzbn: z.string().regex(/^\d{13}$/).optional(),
      ticker: z.string().optional(),
      domain: z.string().optional(),
    }),
  ),
  /** Plain text for the model to read. */
  text: z.string(),
});
export type SourceRecord = z.infer<typeof sourceRecordSchema>;

export interface AdapterContext {
  fetcher: PoliteFetcher;
  now(): Date;
}

/**
 * A source adapter. Phase 2 implements these (ABN Lookup, NZBN, ASX, AusTender, RSS, ...).
 * Adapters must fetch through ctx.fetcher, never fetch() directly: that's what enforces rate
 * limits, retries, caching and robots.txt for every source.
 */
export interface SourceAdapter<Query> {
  readonly id: string;
  readonly description: string;
  /** Terms of use checked, and when. Shown in docs and reviewed before an adapter goes live. */
  readonly termsNote: string;
  fetch(query: Query, ctx: AdapterContext): Promise<SourceRecord[]>;
}
