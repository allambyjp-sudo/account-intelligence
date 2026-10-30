import { describe, expect, it } from "vitest";
import { MemoryCacheStore } from "@/lib/http/cache";
import type { Clock } from "@/lib/http/clock";
import { BackOffError, FetchFailedError, HttpStatusError, RobotsDisallowedError } from "@/lib/http/errors";
import { PoliteFetcher, retryAfterMs } from "@/lib/http/fetcher";
import { createFetcher } from "@/lib/http";
import type { HostPolicy } from "@/lib/http/policy";

/**
 * A clock whose sleeps return at once, moving time forward to when they would have woken. Concurrent
 * sleepers wake in order, so rate limits and backoff are observable.
 */
function fakeClock(start = Date.UTC(2026, 9, 30, 0, 0, 0)): Clock & { sleeps: number[] } {
  let t = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      const wake = t + ms;
      await new Promise((r) => setTimeout(r, 0));
      t = Math.max(t, wake);
    },
  };
}

type Route = (req: { url: string; headers: Record<string, string> }) => Response | Error;

function fakeFetch(routes: Record<string, Route | Route[]>) {
  const calls: Array<{ url: string; headers: Record<string, string>; at: number }> = [];
  let clock: Clock | undefined;
  const impl = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    calls.push({ url, headers, at: clock?.now() ?? 0 });
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    const handler = Array.isArray(route) ? (route.length > 1 ? route.shift()! : route[0]!) : route;
    const out = handler({ url, headers });
    if (out instanceof Error) throw out;
    return out;
  }) as unknown as typeof fetch;
  return { impl, calls, bind: (c: Clock) => (clock = c) };
}

const policy =
  (overrides: Record<string, Partial<HostPolicy>> = {}) =>
  (host: string): HostPolicy => ({ kind: "web", minIntervalMs: 1000, cacheTtlMs: 60_000, ...overrides[host] });

function setup(routes: Record<string, Route | Route[]>, policies = policy()) {
  const clock = fakeClock();
  const f = fakeFetch(routes);
  f.bind(clock);
  const cache = new MemoryCacheStore();
  const fetcher = new PoliteFetcher({
    userAgent: "AccountIntelligenceBot/0.1 (+test@example.com)",
    robotsAgent: "AccountIntelligenceBot",
    cache,
    fetchImpl: f.impl,
    clock,
    random: () => 0,
    policies,
  });
  return { fetcher, clock, calls: f.calls, cache };
}

const ok = (body = "hello", headers: Record<string, string> = {}) => () => new Response(body, { status: 200, headers });
const noRobots = { "https://site.example/robots.txt": () => new Response("", { status: 404 }) };

describe("PoliteFetcher", () => {
  it("sends an honest User-Agent and returns the body", async () => {
    const { fetcher, calls } = setup({ ...noRobots, "https://site.example/a": ok("body text") });
    const res = await fetcher.get("https://site.example/a");
    expect(res.text()).toBe("body text");
    expect(res.fromCache).toBe(false);
    expect(calls.at(-1)!.headers["user-agent"]).toBe("AccountIntelligenceBot/0.1 (+test@example.com)");
  });

  it("spaces requests to the same host by the host's minimum interval", async () => {
    const { fetcher, calls } = setup({ ...noRobots, "https://site.example/a": ok(), "https://site.example/b": ok(), "https://site.example/c": ok() });
    await Promise.all(["a", "b", "c"].map((p) => fetcher.get(`https://site.example/${p}`)));
    expect(calls.filter((c) => c.url.endsWith("robots.txt"))).toHaveLength(1);
    const pageCalls = calls.filter((c) => !c.url.endsWith("robots.txt")).sort((x, y) => x.at - y.at);
    expect(pageCalls).toHaveLength(3);
    const gaps = pageCalls.slice(1).map((c, i) => c.at - pageCalls[i]!.at);
    expect(gaps.every((g) => g >= 1000)).toBe(true);
  });

  it("does not make different hosts wait for each other", async () => {
    const { fetcher, clock } = setup(
      { "https://one.example/x": ok(), "https://two.example/x": ok() },
      policy({ "one.example": { kind: "api" }, "two.example": { kind: "api" } }),
    );
    await fetcher.get("https://one.example/x");
    await fetcher.get("https://two.example/x");
    expect(clock.sleeps).toEqual([]);
  });

  describe("retries", () => {
    it("retries a 503 with exponential backoff, then succeeds", async () => {
      const { fetcher, clock } = setup(
        { "https://api.example/x": [() => new Response("", { status: 503 }), () => new Response("", { status: 503 }), ok("done")] },
        policy({ "api.example": { kind: "api", minIntervalMs: 0 } }),
      );
      const res = await fetcher.get("https://api.example/x");
      expect(res.text()).toBe("done");
      expect(clock.sleeps).toEqual([1000, 2000]);
    });

    it("honours Retry-After on a 429", async () => {
      const { fetcher, clock } = setup(
        { "https://api.example/x": [() => new Response("", { status: 429, headers: { "retry-after": "7" } }), ok()] },
        policy({ "api.example": { kind: "api", minIntervalMs: 0 } }),
      );
      await fetcher.get("https://api.example/x");
      expect(clock.sleeps).toEqual([7000]);
    });

    it("hands back a BackOffError instead of waiting an unreasonable time", async () => {
      const { fetcher } = setup(
        { "https://api.example/x": () => new Response("", { status: 429, headers: { "retry-after": "3600" } }) },
        policy({ "api.example": { kind: "api" } }),
      );
      const err = await fetcher.get("https://api.example/x").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BackOffError);
    });

    it("retries network errors and gives up with a FetchFailedError", async () => {
      const { fetcher, calls } = setup({ "https://api.example/x": () => new TypeError("ECONNRESET") }, policy({ "api.example": { kind: "api", minIntervalMs: 0 } }));
      await expect(fetcher.get("https://api.example/x")).rejects.toBeInstanceOf(FetchFailedError);
      expect(calls).toHaveLength(4);
    });

    it("does not retry a 404", async () => {
      const { fetcher, calls } = setup({ "https://api.example/x": () => new Response("", { status: 404 }) }, policy({ "api.example": { kind: "api" } }));
      const err = await fetcher.get("https://api.example/x").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpStatusError);
      expect((err as HttpStatusError).status).toBe(404);
      expect(calls).toHaveLength(1);
    });
  });

  describe("cache", () => {
    it("serves a fresh entry without touching the network", async () => {
      const { fetcher, calls } = setup({ ...noRobots, "https://site.example/a": ok("v1") });
      await fetcher.get("https://site.example/a");
      const n = calls.length;
      const again = await fetcher.get("https://site.example/a");
      expect(again.fromCache).toBe(true);
      expect(again.text()).toBe("v1");
      expect(calls).toHaveLength(n);
    });

    it("revalidates a stale entry with its ETag and reuses the body on 304", async () => {
      const { fetcher, clock, calls } = setup({
        ...noRobots,
        "https://site.example/a": [ok("v1", { etag: '"abc"' }), () => new Response(null, { status: 304 })],
      });
      await fetcher.get("https://site.example/a");
      await clock.sleep(61_000);
      const res = await fetcher.get("https://site.example/a");
      expect(calls.at(-1)!.headers["if-none-match"]).toBe('"abc"');
      expect(res.fromCache).toBe(true);
      expect(res.text()).toBe("v1");
    });

    it("never caches errors", async () => {
      const { fetcher, cache } = setup({ ...noRobots, "https://site.example/a": () => new Response("", { status: 500 }) });
      await expect(fetcher.get("https://site.example/a")).rejects.toBeInstanceOf(HttpStatusError);
      expect(cache.entries.size).toBe(0);
    });
  });

  describe("robots.txt", () => {
    const robots = (body: string) => ({ "https://site.example/robots.txt": () => new Response(body, { status: 200 }) });

    it("refuses a disallowed path for our agent", async () => {
      const { fetcher } = setup({ ...robots("User-agent: AccountIntelligenceBot\nDisallow: /private\n"), "https://site.example/private/x": ok() });
      await expect(fetcher.get("https://site.example/private/x")).rejects.toBeInstanceOf(RobotsDisallowedError);
    });

    it("allows paths the rules permit", async () => {
      const { fetcher } = setup({ ...robots("User-agent: *\nDisallow: /private\n"), "https://site.example/public": ok("yes") });
      expect((await fetcher.get("https://site.example/public")).text()).toBe("yes");
    });

    it("honours a Crawl-delay longer than the host's own interval", async () => {
      const { fetcher, calls } = setup({
        ...robots("User-agent: *\nCrawl-delay: 10\n"),
        "https://site.example/a": ok(),
        "https://site.example/b": ok(),
      });
      await fetcher.get("https://site.example/a");
      await fetcher.get("https://site.example/b");
      const [a, b] = calls.filter((c) => !c.url.endsWith("robots.txt"));
      expect(b!.at - a!.at).toBeGreaterThanOrEqual(10_000);
    });

    it("treats a missing robots.txt as allow-all", async () => {
      const { fetcher } = setup({ ...noRobots, "https://site.example/a": ok() });
      await expect(fetcher.get("https://site.example/a")).resolves.toBeDefined();
    });

    it("treats an unreachable robots.txt as disallow-all", async () => {
      const { fetcher } = setup({ "https://site.example/robots.txt": () => new Response("", { status: 503 }), "https://site.example/a": ok() });
      await expect(fetcher.get("https://site.example/a")).rejects.toBeInstanceOf(RobotsDisallowedError);
    });

    it("skips robots.txt for documented API hosts", async () => {
      const { fetcher, calls } = setup({ "https://api.example/v1": ok() }, policy({ "api.example": { kind: "api" } }));
      await fetcher.get("https://api.example/v1");
      expect(calls.map((c) => c.url)).toEqual(["https://api.example/v1"]);
    });
  });

  it("applies robots.txt on the host a redirect lands on", async () => {
    const { fetcher } = setup({
      ...noRobots,
      "https://site.example/go": () => new Response(null, { status: 301, headers: { location: "https://other.example/secret" } }),
      "https://other.example/robots.txt": () => new Response("User-agent: *\nDisallow: /\n", { status: 200 }),
      "https://other.example/secret": ok(),
    });
    await expect(fetcher.get("https://site.example/go")).rejects.toBeInstanceOf(RobotsDisallowedError);
  });

  it("refuses non-HTTP URLs", async () => {
    const { fetcher } = setup({});
    await expect(fetcher.get("file:///etc/passwd")).rejects.toThrow(/Refusing/);
  });
});

describe("retryAfterMs", () => {
  it("reads seconds and HTTP dates", () => {
    const now = Date.UTC(2026, 9, 30, 0, 0, 0);
    expect(retryAfterMs("5", now)).toBe(5000);
    expect(retryAfterMs(new Date(now + 30_000).toUTCString(), now)).toBe(30_000);
    expect(retryAfterMs("soon", now)).toBeNull();
  });
});

describe("createFetcher", () => {
  it("won't run without a contact for the User-Agent", () => {
    expect(() => createFetcher({} as never, {})).toThrow(/CRAWLER_CONTACT/);
  });
});
