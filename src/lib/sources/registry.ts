import { ALPHA_VANTAGE, ASX_ANNOUNCEMENTS, AUSTENDER } from "./adapters/market";
import { FEEDS, feedHosts, GOOGLE_NEWS } from "./adapters/news";
import { ABN_LOOKUP, ASX_COMPANIES, NZBN } from "./adapters/registries";
import { CAREERS_PAGE, PDF_REPORT, WEB_PAGE } from "./adapters/web";
import { isEnabled, type AdapterInfo } from "./types";

export * from "./adapters/market";
export * from "./adapters/news";
export * from "./adapters/registries";
export * from "./adapters/web";

/** Every source the app can read, with its status. Shown on /sources and checked by npm run sources:check. */
export const ADAPTERS: AdapterInfo[] = [
  ABN_LOOKUP,
  NZBN,
  ASX_COMPANIES,
  ASX_ANNOUNCEMENTS,
  AUSTENDER,
  GOOGLE_NEWS,
  FEEDS,
  WEB_PAGE,
  CAREERS_PAGE,
  PDF_REPORT,
  ALPHA_VANTAGE,
];

/** Public hosts the adapters call. They name sources, not customers, so the no-real-data guard allows them. */
export function sourceHosts(): string[] {
  return [...new Set([...ADAPTERS.flatMap((a) => a.hosts), ...feedHosts()])];
}

export interface AdapterStatus extends AdapterInfo {
  enabled: boolean;
  configured: boolean;
}

export function adapterStatuses(env: Record<string, string | undefined> = process.env): AdapterStatus[] {
  return ADAPTERS.map((a) => ({ ...a, enabled: isEnabled(a, env), configured: !a.credential || Boolean(env[a.credential]?.trim()) }));
}
