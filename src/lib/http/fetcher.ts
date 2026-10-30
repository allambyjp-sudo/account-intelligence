import robotsParser from "robots-parser";
import type { CachedResponse, HttpCacheStore } from "./cache";
import { systemClock, type Clock } from "./clock";
import { BackOffError, FetchFailedError, HttpStatusError, RobotsDisallowedError } from "./errors";
import { policyFor, type HostPolicy } from "./policy";

export interface FetcherOptions {
  /** Sent on every request. Identifies us honestly and says how to reach us. */
  userAgent: string;
  /** The product token robots.txt rules are matched against. */
  robotsAgent: string;
  cache: HttpCacheStore;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  random?: () => number;
  policies?: (host: string) => HostPolicy;
  /** Total tries per request, including the first. */
  maxAttempts?: number;
  timeoutMs?: number;
  /** Waits longer than this (Retry-After, Crawl-delay) become a BackOffError so the job can reschedule. */
  maxWaitMs?: number;
}

export interface GetOptions {
  headers?: Record<string, string>;
  /** Override the host's cache lifetime for this response. */
  ttlMs?: number;
  /** Ignore a still-fresh cache entry and ask the server again (conditionally, if we can). */
  revalidate?: boolean;
}

export interface FetchResult {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  fromCache: boolean;
  fetchedAt: Date;
  text(): string;
  json<T = unknown>(): T;
}

interface RobotsRules {
  allows(url: string): boolean;
  crawlDelayMs: number;
  expiresAt: number;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const ROBOTS_TTL_MS = 24 * 60 * 60_000;
const ROBOTS_UNREACHABLE_TTL_MS = 60 * 60_000;

/**
 * The only way the app fetches from the outside world. For every source it applies:
 * - a per-host minimum interval between requests (and robots.txt Crawl-delay, if longer);
 * - retries with exponential backoff and jitter on network errors, 429 and 5xx, honouring Retry-After;
 * - a shared response cache with conditional revalidation (ETag / Last-Modified);
 * - robots.txt for websites (RFC 9309: missing file allows all; an unreachable one disallows all);
 * - an honest User-Agent;
 * - the same rules on every redirect hop, since a redirect can land on another host.
 *
 * Rate limits are per process, so external fetching belongs in the worker, not the web app.
 */
export class PoliteFetcher {
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly policies: (host: string) => HostPolicy;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly maxWaitMs: number;
  private readonly nextSlot = new Map<string, number>();
  private readonly robots = new Map<string, RobotsRules>();
  private readonly robotsInFlight = new Map<string, Promise<RobotsRules>>();

  constructor(private readonly opts: FetcherOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.clock = opts.clock ?? systemClock;
    this.random = opts.random ?? Math.random;
    this.policies = opts.policies ?? policyFor;
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxWaitMs = opts.maxWaitMs ?? 120_000;
  }

  async get(url: string, opts: GetOptions = {}, hops = 0): Promise<FetchResult> {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`Refusing to fetch ${u.protocol} URL`);
    const policy = this.policies(u.host);
    const key = `GET ${u.href}`;
    const cached = await this.opts.cache.get(key);
    if (cached && !opts.revalidate && cached.expiresAt.getTime() > this.clock.now()) return toResult(cached, true);

    let minIntervalMs = policy.minIntervalMs;
    if (policy.kind === "web") {
      const rules = await this.robotsFor(u, policy);
      if (!rules.allows(u.href)) throw new RobotsDisallowedError(u.href);
      minIntervalMs = Math.max(minIntervalMs, rules.crawlDelayMs);
    }

    const headers: Record<string, string> = { "user-agent": this.opts.userAgent, ...opts.headers };
    if (cached?.etag) headers["if-none-match"] = cached.etag;
    if (cached?.lastModified) headers["if-modified-since"] = cached.lastModified;

    const res = await this.request(u, headers, minIntervalMs);
    const location = res.headers.get("location");
    if (REDIRECTS.has(res.status) && location) {
      await res.body?.cancel();
      if (hops >= MAX_REDIRECTS) throw new HttpStatusError(u.href, res.status);
      return this.get(new URL(location, u).href, opts, hops + 1);
    }

    const fetchedAt = new Date(this.clock.now());
    const expiresAt = new Date(fetchedAt.getTime() + (opts.ttlMs ?? policy.cacheTtlMs));
    if (res.status === 304 && cached) {
      await res.body?.cancel();
      const refreshed = { ...cached, fetchedAt, expiresAt };
      await this.opts.cache.set(key, refreshed);
      return toResult(refreshed, true);
    }
    if (res.status >= 400) {
      await res.body?.cancel();
      throw new HttpStatusError(u.href, res.status);
    }

    const entry: CachedResponse = {
      url: u.href,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: Buffer.from(await res.arrayBuffer()),
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
      fetchedAt,
      expiresAt,
    };
    if (res.status >= 200 && res.status < 300) await this.opts.cache.set(key, entry);
    return toResult(entry, false);
  }

  /** One rate-limited request with retries. Returns the final response whatever its status. */
  private async request(u: URL, headers: Record<string, string>, minIntervalMs: number): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      await this.acquire(u, minIntervalMs);
      let res: Response;
      try {
        res = await this.fetchImpl(u.href, { headers, redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        if (attempt >= this.maxAttempts) throw new FetchFailedError(u.href, err);
        await this.clock.sleep(this.backoff(attempt));
        continue;
      }
      if (!RETRYABLE.has(res.status) || attempt >= this.maxAttempts) return res;

      const wait = retryAfterMs(res.headers.get("retry-after"), this.clock.now()) ?? this.backoff(attempt);
      await res.body?.cancel();
      if (wait > this.maxWaitMs) throw new BackOffError(u.href, new Date(this.clock.now() + wait));
      this.deferHost(u.host, this.clock.now() + wait);
    }
  }

  /** Reserves the host's next free slot, then waits for it. Reservation is synchronous, so concurrent callers queue. */
  private async acquire(u: URL, minIntervalMs: number): Promise<void> {
    const now = this.clock.now();
    const slot = Math.max(now, this.nextSlot.get(u.host) ?? 0);
    if (slot - now > this.maxWaitMs) throw new BackOffError(u.href, new Date(slot));
    this.nextSlot.set(u.host, slot + minIntervalMs);
    if (slot > now) await this.clock.sleep(slot - now);
  }

  private deferHost(host: string, until: number) {
    this.nextSlot.set(host, Math.max(this.nextSlot.get(host) ?? 0, until));
  }

  private backoff(attempt: number): number {
    return Math.min(30_000, 1_000 * 2 ** (attempt - 1)) + Math.floor(this.random() * 250);
  }

  private async robotsFor(u: URL, policy: HostPolicy): Promise<RobotsRules> {
    const hit = this.robots.get(u.origin);
    if (hit && hit.expiresAt > this.clock.now()) return hit;
    // Concurrent first requests to a host share one robots.txt fetch.
    let pending = this.robotsInFlight.get(u.origin);
    if (!pending) {
      pending = this.loadRobots(u, policy).finally(() => this.robotsInFlight.delete(u.origin));
      this.robotsInFlight.set(u.origin, pending);
    }
    return pending;
  }

  private async loadRobots(u: URL, policy: HostPolicy): Promise<RobotsRules> {
    let target = new URL("/robots.txt", u.origin);
    let rules: RobotsRules | undefined;
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS && !rules; hop++) {
        const res = await this.request(target, { "user-agent": this.opts.userAgent }, policy.minIntervalMs);
        const location = res.headers.get("location");
        if (REDIRECTS.has(res.status) && location) {
          await res.body?.cancel();
          target = new URL(location, target);
        } else if (res.ok) {
          const parsed = robotsParser(target.href, await res.text());
          rules = {
            // isAllowed is undefined for URLs on another origin; the rules here only cover this one.
            allows: (url) => parsed.isAllowed(url, this.opts.robotsAgent) !== false,
            crawlDelayMs: (parsed.getCrawlDelay(this.opts.robotsAgent) ?? 0) * 1000,
            expiresAt: this.clock.now() + ROBOTS_TTL_MS,
          };
        } else {
          await res.body?.cancel();
          const unavailable = res.status >= 400 && res.status < 500 && res.status !== 429;
          rules = unavailable ? allowAll(this.clock.now() + ROBOTS_TTL_MS) : disallowAll(this.clock.now() + ROBOTS_UNREACHABLE_TTL_MS);
        }
      }
    } catch (err) {
      if (!(err instanceof FetchFailedError)) throw err;
    }
    rules ??= disallowAll(this.clock.now() + ROBOTS_UNREACHABLE_TTL_MS);
    this.robots.set(u.origin, rules);
    return rules;
  }
}

const allowAll = (expiresAt: number): RobotsRules => ({ allows: () => true, crawlDelayMs: 0, expiresAt });
const disallowAll = (expiresAt: number): RobotsRules => ({ allows: () => false, crawlDelayMs: 0, expiresAt });

export function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function toResult(entry: CachedResponse, fromCache: boolean): FetchResult {
  return {
    url: entry.url,
    status: entry.status,
    headers: entry.headers,
    body: entry.body,
    fromCache,
    fetchedAt: entry.fetchedAt,
    text: () => entry.body.toString("utf8"),
    json: <T>() => JSON.parse(entry.body.toString("utf8")) as T,
  };
}
