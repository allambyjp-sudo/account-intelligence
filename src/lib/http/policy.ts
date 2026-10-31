/**
 * Per-host access rules. Every external source goes through PoliteFetcher, which applies these.
 *
 * kind "api": a documented API we have permission to call (often with a registered key). Its
 *   terms of use govern access, so robots.txt isn't consulted.
 * kind "web": an ordinary website. robots.txt is honoured, including Crawl-delay.
 *
 * Add a host here when you write its adapter, with a note on the terms you checked.
 */
export interface HostPolicy {
  kind: "api" | "web";
  /** Minimum gap between requests to this host. */
  minIntervalMs: number;
  /** How long a successful response is reused before we ask again. */
  cacheTtlMs: number;
  note?: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULT_POLICY: HostPolicy = { kind: "web", minIntervalMs: 2_000, cacheTtlMs: 6 * HOUR };

export const HOST_POLICIES: Record<string, Partial<HostPolicy>> = {
  "abr.business.gov.au": { kind: "api", minIntervalMs: 1_000, cacheTtlMs: 7 * DAY, note: "ABN Lookup web services. Needs a registered GUID." },
  "api.business.govt.nz": { kind: "api", minIntervalMs: 1_000, cacheTtlMs: 7 * DAY, note: "NZBN API. Needs a registered key." },
  "api.tenders.gov.au": { kind: "api", minIntervalMs: 2_000, cacheTtlMs: 12 * HOUR, note: "AusTender OCDS API. Data under CC BY 3.0 AU." },
  "www.alphavantage.co": { kind: "api", minIntervalMs: 13_000, cacheTtlMs: 12 * HOUR, note: "Free tier: 5 requests/minute, about 25/day." },
  "news.google.com": { kind: "web", minIntervalMs: 5_000, cacheTtlMs: 30 * MINUTE, note: "RSS search feeds only." },
  "www.asx.com.au": { kind: "web", minIntervalMs: 5_000, cacheTtlMs: 7 * DAY, note: "Listed companies CSV." },
  "asx.api.markitdigital.com": { kind: "web", minIntervalMs: 5_000, cacheTtlMs: 30 * MINUTE, note: "Disabled until ASX terms are checked." },
  "graph.microsoft.com": { kind: "api", minIntervalMs: 200, cacheTtlMs: 0, note: "Delegated Mail.Read (Phase 6)." },
  "api.voyageai.com": { kind: "api", minIntervalMs: 200, cacheTtlMs: 0, note: "Optional embeddings provider." },
};

export function policyFor(host: string): HostPolicy {
  return { ...DEFAULT_POLICY, ...HOST_POLICIES[host.toLowerCase()] };
}
