import { MemoryCacheStore } from "@/lib/http/cache";
import { PoliteFetcher } from "@/lib/http/fetcher";
import { ROBOTS_AGENT } from "@/lib/http";
import { alphaVantageDaily, austender } from "@/lib/sources/adapters/market";
import { configuredFeeds, googleNews, loadFeeds } from "@/lib/sources/adapters/news";
import { abnSearch, asxCompanies, nzbnSearch } from "@/lib/sources/adapters/registries";
import { adapterStatuses } from "@/lib/sources/registry";
import { SourceDisabledError, SourceNotConfiguredError, type AdapterContext } from "@/lib/sources/types";
import { loadEnv } from "./env";

/**
 * Makes one small live call to each source and reports whether the response parsed. Run it after
 * opening the network or adding a key:
 *   npm run sources:check
 *   npm run sources:check -- --company "Australian Taxation Office" --ticker WBC
 * Nothing is stored. It uses an in-memory cache, so every call is fresh.
 */
async function main() {
  loadEnv();
  const arg = (name: string, fallback: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
  };
  const company = arg("company", "Australian Taxation Office");
  const ticker = arg("ticker", "BHP");
  const contact = process.env.CRAWLER_CONTACT?.trim();
  if (!contact) throw new Error("Set CRAWLER_CONTACT first; it goes in the User-Agent.");
  const fetcher = new PoliteFetcher({ userAgent: `${ROBOTS_AGENT}/0.1 (+${contact})`, robotsAgent: ROBOTS_AGENT, cache: new MemoryCacheStore() });
  const ctx: AdapterContext = { fetcher, env: process.env, now: () => new Date() };
  const now = new Date();

  const checks: Array<[string, () => Promise<string>]> = [
    ["abn_lookup", async () => `${(await abnSearch.fetch({ name: company, max: 3 }, ctx)).length} matches`],
    ["nzbn", async () => `${(await nzbnSearch.fetch({ name: arg("nz-company", "Air New Zealand"), max: 3 }, ctx)).length} matches`],
    ["asx_companies", async () => `${(await asxCompanies.fetch({ name: ticker, max: 3 }, ctx)).length} matches`],
    ["austender", async () => `${(await austender.fetch({ names: ["department"], from: new Date(now.getTime() - 86_400_000), to: now, maxPages: 1 }, ctx)).length} notices naming "department" in the last day`],
    ["google_news", async () => `${(await googleNews.fetch({ companyName: company, region: "AU", days: 7 }, ctx)).length} items`],
    ["alpha_vantage", async () => `${(await alphaVantageDaily.fetch({ exchange: "ASX", ticker, companyName: ticker }, ctx)).points.length} daily closes for ${ticker}.AX`],
  ];
  for (const feed of loadFeeds().filter((f) => f.enabled && f.url)) {
    checks.push([`feed:${feed.id}`, async () => {
      const res = await configuredFeeds.fetch({ kind: feed.kind, feeds: [feed] }, ctx);
      if (res.failures.length) throw new Error(res.failures[0]!.error);
      if (!res.records.length) throw new Error("fetched, but no items parsed: check the URL and format");
      return `${res.records.length} items`;
    }]);
  }

  let failures = 0;
  for (const [name, run] of checks) {
    try {
      console.log(`ok       ${name}: ${await run()}`);
    } catch (err) {
      if (err instanceof SourceNotConfiguredError || err instanceof SourceDisabledError) console.log(`skipped  ${name}: ${err.message}`);
      else {
        failures++;
        console.log(`FAILED   ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  console.log("\nAdapter status:");
  for (const a of adapterStatuses()) console.log(`  ${a.enabled ? "on " : "off"} ${a.configured ? "   " : "key"} ${a.id}${a.formatVerified ? "" : "  (format not yet confirmed live)"}`);
  console.log("\nWhen a source passes here, set formatVerified: true in its adapter (or verified: true in data/news-feeds.json).");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
