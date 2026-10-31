import { MemoryCacheStore } from "@/lib/http/cache";
import { PoliteFetcher } from "@/lib/http/fetcher";
import type { HostPolicy } from "@/lib/http/policy";
import type { AdapterContext } from "@/lib/sources/types";

export type Responder = string | Uint8Array | { status?: number; body?: string | Uint8Array; headers?: Record<string, string> };

/**
 * A PoliteFetcher whose network is a map of URL to response. Unknown URLs 404. Every host is
 * treated as an API (no robots.txt, no waiting) so adapter tests stay about parsing.
 */
export function fakeFetcher(routes: Record<string, Responder | ((url: string, headers: Record<string, string>) => Responder)>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    calls.push({ url, headers });
    const route = routes[url];
    const r = typeof route === "function" ? route(url, headers) : route;
    if (r === undefined) return new Response("not found", { status: 404 });
    if (typeof r === "string" || r instanceof Uint8Array) return new Response(r as BodyInit, { status: 200 });
    return new Response((r.body ?? "") as BodyInit, { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  const policies = (): HostPolicy => ({ kind: "api", minIntervalMs: 0, cacheTtlMs: 60_000 });
  const fetcher = new PoliteFetcher({ userAgent: "test", robotsAgent: "test", cache: new MemoryCacheStore(), fetchImpl, policies, random: () => 0 });
  return { fetcher, calls };
}

export function adapterContext(fetcher: PoliteFetcher, env: Record<string, string | undefined> = {}): AdapterContext {
  return { fetcher, env, now: () => new Date("2026-10-30T00:00:00Z") };
}
