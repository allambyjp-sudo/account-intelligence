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
  /** A page a person can open to check the claim. Never an API URL that carries a key. */
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
  /** Set when the same URL can change over time (careers pages), so each version is kept. */
  contentHash: z.string().optional(),
  /** Adapter-specific structured extras (e.g. tech footprint hits, contract values). */
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type SourceRecord = z.infer<typeof sourceRecordSchema>;

export interface AdapterContext {
  fetcher: PoliteFetcher;
  env: Record<string, string | undefined>;
  now(): Date;
}

export interface AdapterInfo {
  id: string;
  description: string;
  /** Hosts it calls. Feeds the fetch policy and the no-real-data guard's allowlist. */
  hosts: string[];
  /** Has the response format been checked against a live response? `npm run sources:check` does this. */
  formatVerified: boolean;
  /** What we know about the source's terms of use, and what still needs checking. */
  termsNote: string;
  /** Environment variable holding a key, if the source needs one. */
  credential?: string;
  /** Sources whose terms still need reading start disabled. SOURCES_ENABLED / SOURCES_DISABLED override. */
  defaultEnabled: boolean;
}

/**
 * A source adapter. Adapters must fetch through ctx.fetcher, never fetch() directly: that's what
 * enforces rate limits, retries, caching and robots.txt for every source.
 */
export interface SourceAdapter<Query, Result = SourceRecord[]> {
  readonly info: AdapterInfo;
  fetch(query: Query, ctx: AdapterContext): Promise<Result>;
}

/** The adapter needs a key or URL that hasn't been configured yet. Callers skip it and say so. */
export class SourceNotConfiguredError extends Error {
  override name = "SourceNotConfiguredError";
  constructor(
    readonly adapter: string,
    readonly missing: string,
  ) {
    super(`${adapter} needs ${missing}`);
  }
}

export class SourceDisabledError extends Error {
  override name = "SourceDisabledError";
  constructor(readonly adapter: string) {
    super(`${adapter} is disabled. Enable it with SOURCES_ENABLED=${adapter} once its terms have been checked.`);
  }
}

const list = (v: string | undefined) =>
  new Set(
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

export function isEnabled(info: AdapterInfo, env: Record<string, string | undefined>): boolean {
  if (list(env.SOURCES_DISABLED).has(info.id)) return false;
  if (list(env.SOURCES_ENABLED).has(info.id)) return true;
  return info.defaultEnabled;
}

/** Throws unless the adapter is enabled and its credential (if any) is present. Returns the credential. */
export function requireReady(info: AdapterInfo, env: Record<string, string | undefined>): string | undefined {
  if (!isEnabled(info, env)) throw new SourceDisabledError(info.id);
  if (!info.credential) return undefined;
  const value = env[info.credential]?.trim();
  if (!value) throw new SourceNotConfiguredError(info.id, info.credential);
  return value;
}

/** Normalises company names for matching: lowercase, no punctuation or legal suffixes. */
export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(pty|ltd|limited|proprietary|inc|incorporated|plc|corporation|corp|co|company|holdings?|group|the|nz|australia|aust)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const capText = (s: string, max = 200_000) => (s.length > max ? `${s.slice(0, max)}\n[truncated]` : s);
