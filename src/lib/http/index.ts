import type { Db } from "@/lib/db/client";
import { PoliteFetcher } from "./fetcher";
import { PgCacheStore } from "./pg-cache";

export * from "./errors";
export { PoliteFetcher, type FetchResult, type GetOptions } from "./fetcher";
export { policyFor, HOST_POLICIES, type HostPolicy } from "./policy";

export const ROBOTS_AGENT = "AccountIntelligenceBot";

/** Builds the production fetcher. CRAWLER_CONTACT goes in the User-Agent so site owners can reach us. */
export function createFetcher(db: Db, env: Record<string, string | undefined> = process.env): PoliteFetcher {
  const contact = env.CRAWLER_CONTACT?.trim();
  if (!contact) {
    throw new Error("Set CRAWLER_CONTACT to an email address or URL where site owners can reach you; it goes in the User-Agent.");
  }
  return new PoliteFetcher({
    userAgent: `${ROBOTS_AGENT}/0.1 (+${contact})`,
    robotsAgent: ROBOTS_AGENT,
    cache: new PgCacheStore(db),
  });
}
