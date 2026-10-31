import type { Db } from "@/lib/db/client";
import type { Account, Entity, Source } from "@/lib/db/schema";
import type { PoliteFetcher } from "@/lib/http";
import type { LLMProvider } from "@/lib/llm/types";
import { getPrompt, renderPrompt } from "@/lib/prompts/loader";
import { asxAnnouncements, austender } from "@/lib/sources/adapters/market";
import { configuredFeeds, googleNews } from "@/lib/sources/adapters/news";
import { abnDetails } from "@/lib/sources/adapters/registries";
import { careersPage, pdfReport, webPage, type LinkKind } from "@/lib/sources/adapters/web";
import type { FootprintHit } from "@/lib/sources/footprint";
import { upsertSource } from "@/lib/sources/store";
import { normaliseName, SourceDisabledError, SourceNotConfiguredError, type AdapterContext, type SourceRecord } from "@/lib/sources/types";

export interface GatherStats {
  sources: Record<string, number>;
  skipped: Record<string, string>;
  failed: Record<string, string>;
}

export interface Gathered {
  sources: Source[];
  footprint: Array<{ hit: FootprintHit; sourceId: string }>;
  stats: GatherStats;
  webSearchUsage?: { inputTokens: number; outputTokens: number; webSearches: number };
}

export interface GatherInput {
  db: Db;
  fetcher: PoliteFetcher;
  llm: LLMProvider;
  env: Record<string, string | undefined>;
  account: Account;
  entities: Entity[];
  now: Date;
}

/** Social networks are never searched or cited: their terms prohibit automated collection, and they hold personal detail. */
export const BLOCKED_WEB_DOMAINS = ["linkedin.com", "facebook.com", "instagram.com", "tiktok.com", "x.com", "twitter.com", "seek.com.au", "seek.co.nz"];

const FOLLOW: LinkKind[] = ["about", "leadership", "investors", "case_study"];
const DAY = 86_400_000;

/**
 * Stage 1 of a research run: read every enabled source for the account and store what comes back.
 * A source that isn't configured or fails is recorded in stats and skipped; it never fails the run.
 */
export async function gather(input: GatherInput): Promise<Gathered> {
  const { db, fetcher, llm, env, account, entities, now } = input;
  const ctx: AdapterContext = { fetcher, env, now: () => now };
  const primary = entities.find((e) => e.isPrimary) ?? entities[0];
  const stats: GatherStats = { sources: {}, skipped: {}, failed: {} };
  const stored = new Map<string, Source>();
  const footprint: Gathered["footprint"] = [];

  const save = async (records: SourceRecord[]) => {
    const rows: Source[] = [];
    for (const r of records) {
      const row = await upsertSource(db, r);
      stored.set(row.id, row);
      stats.sources[r.adapter] = (stats.sources[r.adapter] ?? 0) + 1;
      rows.push(row);
    }
    return rows;
  };
  const attempt = async <T>(adapter: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SourceNotConfiguredError || err instanceof SourceDisabledError) stats.skipped[adapter] = err.message;
      else stats.failed[adapter] = err instanceof Error ? err.message : String(err);
      return undefined;
    }
  };

  const names = [...new Set([account.name, ...entities.map((e) => e.legalName)])];
  const ticker = primary?.ticker ?? null;

  // Registry record.
  if (primary?.abn) await attempt("abn_lookup", async () => save([await abnDetails.fetch({ abn: primary.abn! }, ctx)]));

  // The company's own website, and the pages it links to that matter to a seller.
  const homepage = account.websiteUrl ?? (primary?.domain ? `https://${primary.domain}/` : null);
  let discoveredCareers: string | null = null;
  if (homepage) {
    const home = await attempt("web_page", () => webPage.fetch({ url: homepage, companyName: account.name }, ctx));
    if (home) {
      const [row] = await save([home.record]);
      for (const hit of home.footprint) footprint.push({ hit, sourceId: row!.id });
      discoveredCareers = home.interestingLinks.find((l) => l.kind === "careers")?.href ?? null;
      const follow = home.interestingLinks.filter((l) => FOLLOW.includes(l.kind)).slice(0, 6);
      for (const link of follow) {
        const page = await attempt(`web_page:${link.kind}`, () =>
          webPage.fetch({ url: link.href, companyName: account.name, sourceType: link.kind === "case_study" ? "case_study" : "web" }, ctx),
        );
        if (page) await save([page.record]);
      }
    }
  } else stats.skipped.web_page = "No website or domain on the account";

  // Careers page: a source of tech hiring signals.
  const careersUrl = account.careersUrl ?? discoveredCareers;
  if (careersUrl) {
    const careers = await attempt("careers_page", () => careersPage.fetch({ url: careersUrl, companyName: account.name }, ctx));
    if (careers) {
      const [row] = await save([careers.record]);
      for (const hit of careers.footprint) footprint.push({ hit, sourceId: row!.id });
    }
  }

  // Annual and half-year reports the seller has pointed us at.
  for (const url of account.reportUrls.slice(0, 3)) {
    const recs = await attempt("pdf_report", () => pdfReport.fetch({ url, companyName: account.name }, ctx));
    if (recs) await save(recs);
  }

  // News, ANZ tech press and (for ASX-listed accounts) announcements.
  const region = primary?.country === "NZ" ? "NZ" : "AU";
  const news = await attempt("google_news", () =>
    googleNews.fetch({ companyName: account.name, ticker, extraTerms: account.newsTerms, region, days: 90 }, ctx),
  );
  if (news) await save(news.slice(0, 25));
  const press = await attempt("feeds", () => configuredFeeds.fetch({ kind: "news", terms: [...names, ...account.newsTerms] }, ctx));
  if (press) {
    await save(press.records.slice(0, 15));
    for (const f of press.failures) stats.failed[`feed_${f.feed}`] = f.error;
  }
  if (ticker && primary?.exchange === "ASX") {
    const ann = await attempt("asx_announcements", () => asxAnnouncements.fetch({ ticker, companyName: account.name, limit: 20 }, ctx));
    if (ann) await save(ann);
  }

  // Government contracts in the last 30 days (monitoring keeps this up to date afterwards).
  const tenders = await attempt("austender", () =>
    austender.fetch({ abn: primary?.abn ?? undefined, names: names.map(normaliseName), from: new Date(now.getTime() - 30 * DAY), to: now, maxPages: 20 }, ctx),
  );
  if (tenders) await save(tenders);

  // Web search fills gaps the adapters can't reach, when the model provider offers it.
  let webSearchUsage: Gathered["webSearchUsage"];
  if (llm.capabilities.webSearch && env.RESEARCH_WEB_SEARCH !== "off") {
    await attempt("web_search", async () => {
      const prompt = getPrompt("research.web_gather");
      const res = await llm.generate({
        task: "research",
        system: getPrompt("system.base").template,
        prompt: { id: prompt.id, version: prompt.version },
        messages: [
          {
            role: "user",
            content: renderPrompt(prompt, {
              company_name: account.name,
              country: primary?.country === "NZ" ? "New Zealand" : "Australia",
              domains: entities.map((e) => e.domain).filter(Boolean).join(", ") || "unknown",
              today: now.toISOString().slice(0, 10),
            }),
          },
        ],
        webSearch: { maxUses: 8, blockedDomains: BLOCKED_WEB_DOMAINS },
      });
      webSearchUsage = { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, webSearches: res.usage.webSearches };
      // Each cited page becomes a source whose text is what was quoted from it.
      const byUrl = new Map<string, { title: string | null; quotes: string[] }>();
      for (const c of res.citations) {
        if (BLOCKED_WEB_DOMAINS.some((d) => new URL(c.url).host.endsWith(d))) continue;
        const e = byUrl.get(c.url) ?? { title: c.title, quotes: [] };
        if (!e.quotes.includes(c.citedText)) e.quotes.push(c.citedText);
        byUrl.set(c.url, e);
      }
      await save(
        [...byUrl.entries()].map(([url, e]) => ({
          adapter: "web_search",
          sourceType: "web" as const,
          url,
          title: e.title,
          publisher: new URL(url).host.replace(/^www\./, ""),
          publishedAt: null,
          retrievedAt: now,
          entities: [{ name: account.name }],
          text: e.quotes.join("\n\n"),
        })),
      );
    });
  } else stats.skipped.web_search = llm.capabilities.webSearch ? "Turned off (RESEARCH_WEB_SEARCH=off)" : `The ${llm.name} provider has no web search`;

  return { sources: [...stored.values()], footprint, stats, webSearchUsage };
}
