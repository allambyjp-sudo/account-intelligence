import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { mentions, parseFeed } from "../feeds";
import { requireReady, type AdapterContext, type AdapterInfo, type SourceAdapter, type SourceRecord } from "../types";

// ---------------------------------------------------------------------------------------------
// Google News RSS search
// ---------------------------------------------------------------------------------------------

export const GOOGLE_NEWS: AdapterInfo = {
  id: "google_news",
  description: "Google News RSS search, filtered by company name and ticker. Also carries AFR headlines (site:afr.com).",
  hosts: ["news.google.com"],
  formatVerified: false,
  termsNote: "Public RSS search feed. Low volume, cached for 30 minutes per query. Headlines and links only; articles stay with their publishers.",
  defaultEnabled: true,
};

export interface NewsQuery {
  companyName: string;
  ticker?: string | null;
  extraTerms?: string[];
  /** Region edition: AU or NZ. */
  region: "AU" | "NZ";
  /** Only items from the last N days. */
  days?: number;
}

export function googleNewsUrl(q: NewsQuery, extra = ""): string {
  const terms = [`"${q.companyName}"`, ...(q.ticker ? [`"${q.ticker}"`] : []), ...(q.extraTerms ?? []).map((t) => `"${t}"`)];
  const query = `(${terms.join(" OR ")})${extra ? ` ${extra}` : ""} when:${q.days ?? 30}d`;
  const ed = q.region === "NZ" ? { hl: "en-NZ", gl: "NZ", ceid: "NZ:en" } : { hl: "en-AU", gl: "AU", ceid: "AU:en" };
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${ed.hl}&gl=${ed.gl}&ceid=${ed.ceid}`;
}

export const googleNews: SourceAdapter<NewsQuery> = {
  info: GOOGLE_NEWS,
  async fetch(q, ctx) {
    requireReady(GOOGLE_NEWS, ctx.env);
    const [general, afr] = await Promise.all([
      ctx.fetcher.get(googleNewsUrl(q), { ttlMs: 30 * 60_000 }),
      ctx.fetcher.get(googleNewsUrl(q, "site:afr.com"), { ttlMs: 30 * 60_000 }),
    ]);
    const seen = new Set<string>();
    const out: SourceRecord[] = [];
    for (const res of [general, afr]) {
      for (const item of parseFeed(res.text())) {
        // Google News titles end with " - Publisher"; keep the headline clean.
        const title = item.publisher && item.title.endsWith(` - ${item.publisher}`) ? item.title.slice(0, -item.publisher.length - 3) : item.title;
        const key = title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          adapter: GOOGLE_NEWS.id,
          sourceType: "news",
          url: item.url,
          title,
          publisher: item.publisher,
          publishedAt: item.publishedAt,
          retrievedAt: res.fetchedAt,
          entities: [{ name: q.companyName, ...(q.ticker ? { ticker: q.ticker } : {}) }],
          text: [title, item.summary && item.summary !== title ? item.summary : null].filter(Boolean).join("\n"),
        });
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// Configured feeds: ANZ tech press, ACSC advisories, GETS (data/news-feeds.json)
// ---------------------------------------------------------------------------------------------

const feedSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string(),
  kind: z.enum(["news", "advisory", "tender"]),
  url: z.url().nullable(),
  region: z.enum(["AU", "NZ", "GLOBAL"]),
  verified: z.boolean(),
  enabled: z.boolean(),
  note: z.string().optional(),
});
export type FeedConfig = z.infer<typeof feedSchema>;

export const FEEDS_FILE = path.join(process.cwd(), "data/news-feeds.json");

export function loadFeeds(file = FEEDS_FILE): FeedConfig[] {
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  return z.object({ $comment: z.string().optional(), feeds: z.array(feedSchema) }).parse(raw).feeds;
}

export const FEEDS: AdapterInfo = {
  id: "feeds",
  description: "ANZ tech press, ACSC alerts and advisories, and GETS, from the feed list in data/news-feeds.json.",
  hosts: [],
  formatVerified: false,
  termsNote: "Publishers' public RSS/Atom feeds. Headlines, summaries and links only.",
  defaultEnabled: true,
};

export interface FeedQuery {
  kind: FeedConfig["kind"];
  /** When set, keep only items that mention one of these (company names, tickers, products). */
  terms?: string[];
  feeds?: FeedConfig[];
}

export interface FeedResult {
  records: SourceRecord[];
  /** Per-feed problems, so one broken feed never hides the rest. */
  failures: Array<{ feed: string; error: string }>;
}

export const configuredFeeds: SourceAdapter<FeedQuery, FeedResult> = {
  info: FEEDS,
  async fetch({ kind, terms, feeds }, ctx) {
    requireReady(FEEDS, ctx.env);
    const list = (feeds ?? loadFeeds()).filter((f) => f.kind === kind && f.enabled && f.url);
    const records: SourceRecord[] = [];
    const failures: FeedResult["failures"] = [];
    await Promise.all(
      list.map(async (feed) => {
        try {
          const res = await ctx.fetcher.get(feed.url!, { ttlMs: 30 * 60_000 });
          for (const item of parseFeed(res.text())) {
            if (terms?.length && !mentions(`${item.title}\n${item.summary}`, terms)) continue;
            records.push({
              adapter: `feed_${feed.id}`,
              sourceType: kind === "advisory" ? "advisory" : kind === "tender" ? "tender" : "news",
              url: item.url,
              title: item.title,
              publisher: feed.name,
              publishedAt: item.publishedAt,
              retrievedAt: res.fetchedAt,
              entities: [],
              text: [item.title, item.summary].filter(Boolean).join("\n"),
            });
          }
        } catch (err) {
          failures.push({ feed: feed.id, error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );
    return { records, failures };
  },
};

export function feedHosts(feeds = loadFeeds()): string[] {
  return feeds.filter((f) => f.url).map((f) => new URL(f.url!).host);
}

export type { AdapterContext };
