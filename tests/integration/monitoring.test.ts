import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as t from "@/lib/db/schema";
import { MockProvider } from "@/lib/llm/mock";
import { matchAdvisories } from "@/lib/monitor/advisories";
import { classifySignals } from "@/lib/monitor/classify";
import { monitorAccount } from "@/lib/monitor/poll";
import { raiseQuietAlerts } from "@/lib/monitor/quiet";
import { googleNewsUrl } from "@/lib/sources/adapters/news";
import { DEV_IDENTITY, upsertUser } from "@/lib/users";
import { fakeFetcher, type Responder } from "../helpers/fake-fetcher";
import { createTestDb, hasTestDb, type TestDb } from "./db-helpers";

const NOW = new Date("2026-10-30T00:00:00Z");
const rss = (items: Array<[string, string, string]>) =>
  `<rss version="2.0"><channel>${items.map(([title, url, date]) => `<item><title>${title}</title><link>${url}</link><pubDate>${date}</pubDate><description>${title}</description></item>`).join("")}</channel></rss>`;

describe.skipIf(!hasTestDb)("live monitoring", () => {
  let tdb: TestDb;
  let userId: string;
  let accountId: string;
  let entityId: string;

  beforeAll(async () => {
    tdb = await createTestDb();
    userId = (await upsertUser(tdb.db, DEV_IDENTITY)).id;
    const [a] = await tdb.db
      .insert(t.accounts)
      .values({ ownerUserId: userId, name: "Bellbird Logistics", careersUrl: "https://bellbird.example/careers", isKeyAccount: true, lastContactAt: new Date("2026-09-01T00:00:00Z") })
      .returning();
    accountId = a!.id;
    const [e] = await tdb.db.insert(t.entities).values({ accountId, legalName: "Bellbird Logistics Ltd", country: "AU", exchange: "ASX", ticker: "BLG", isPrimary: true }).returning();
    entityId = e!.id;
    await tdb.db.insert(t.techStackItems).values({ accountId, vendor: "Citrix", product: "NetScaler ADC", category: "network", evidenceKind: "job_ad" });
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  const q = { companyName: "Bellbird Logistics", ticker: "BLG", extraTerms: [], region: "AU" as const, days: 7 };
  const env = { ALPHA_VANTAGE_API_KEY: "k", SOURCES_DISABLED: "feeds,austender" };
  const avUrl = "https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=BLG.AX&outputsize=compact&apikey=k";
  const routes = (careers: string, news: Array<[string, string, string]>): Record<string, Responder> => ({
    [googleNewsUrl(q)]: rss(news),
    [googleNewsUrl(q, "site:afr.com")]: rss([]),
    "https://bellbird.example/careers": { body: `<html><body><main>${careers}</main></body></html>`, headers: { "content-type": "text/html" } },
    [avUrl]: JSON.stringify({ "Time Series (Daily)": { "2026-10-28": { "4. close": "4.00" }, "2026-10-29": { "4. close": "3.50" } } }),
  });

  it("turns new items into signals, once, and records prices and price moves", async () => {
    const news: Array<[string, string, string]> = [
      ["Bellbird Logistics names new CIO", "https://news.example/cio", "Wed, 28 Oct 2026 01:00:00 GMT"],
      ["Bellbird Logistics in 2019 retrospective", "https://news.example/old", "Mon, 01 Jul 2019 01:00:00 GMT"],
    ];
    const first = fakeFetcher(routes("<p>Driver</p><p>Data Analyst</p>", news));
    const r1 = await monitorAccount({ db: tdb.db, fetcher: first.fetcher, env, now: () => NOW }, accountId);
    expect(r1.failed).toEqual({});
    // News (1 recent; the 2019 item is too old) + a 12.5% price drop. The first careers page is a baseline.
    expect(r1.newSignals).toBe(2);

    const prices = await tdb.db.select().from(t.pricePoints).where(eq(t.pricePoints.entityId, entityId));
    expect(prices.map((p) => [p.tradeDate, Number(p.close)])).toEqual([
      ["2026-10-28", 4],
      ["2026-10-29", 3.5],
    ]);
    const [move] = await tdb.db.select().from(t.signals).where(and(eq(t.signals.accountId, accountId), eq(t.signals.channel, "share_price")));
    expect(move).toMatchObject({ importance: "high", classifier: "rules:price-move@1" });

    // Second poll: same news (no new signal), a new role on the careers page, prices not re-fetched today.
    const second = fakeFetcher(routes("<p>Driver</p><p>Data Analyst</p><p>Cloud Security Engineer</p>", news));
    const r2 = await monitorAccount({ db: tdb.db, fetcher: second.fetcher, env, now: () => new Date(NOW.getTime() + 3_600_000) }, accountId);
    expect(r2.newSignals).toBe(1);
    expect(second.calls.some((c) => c.url === avUrl)).toBe(false);
    const [careers] = await tdb.db.select().from(t.signals).where(and(eq(t.signals.accountId, accountId), eq(t.signals.channel, "careers_change")));
    expect(careers!.summary).toBe("Cloud Security Engineer");
  });

  it("classifies pending signals, hides ones that aren't about the company, and alerts on high importance", async () => {
    const llm = new MockProvider((req) => {
      const refs = [...String(req.messages[0]!.content).matchAll(/ref="(I\d+)"[^>]*>\n([^\n]*)/g)];
      return {
        items: refs.map(([, ref, title]) =>
          title!.includes("CIO")
            ? { ref, aboutThisCompany: true, signalType: "leadership_change", importance: "high", summary: "New CIO", whyItMatters: "New leaders review vendors." }
            : { ref, aboutThisCompany: false, signalType: "other", importance: "medium", summary: "Not them", whyItMatters: "" },
        ),
      };
    });
    const res = await classifySignals(tdb.db, llm, accountId, NOW);
    expect(res.classified).toBe(2);
    expect(res.high.map((s) => s.title)).toEqual(["Bellbird Logistics names new CIO"]);
    const careers = await tdb.db.select().from(t.signals).where(and(eq(t.signals.accountId, accountId), eq(t.signals.channel, "careers_change")));
    expect(careers[0]).toMatchObject({ relevant: false, importance: "low" });
    const alerts = await tdb.db.select().from(t.alerts).where(eq(t.alerts.accountId, accountId));
    expect(alerts).toEqual([expect.objectContaining({ kind: "signal", importance: "high", body: "New leaders review vendors." })]);
    // Nothing left to classify.
    expect((await classifySignals(tdb.db, llm, accountId, NOW)).classified).toBe(0);
  });

  it("matches ACSC advisories to accounts whose stack names the product", async () => {
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Critical vulnerability in NetScaler ADC</title><link href="https://advisories.example/netscaler"/><updated>2026-10-29T00:00:00Z</updated><summary>Patch now</summary></entry>
      <entry><title>FortiOS advisory</title><link href="https://advisories.example/forti"/><updated>2026-10-29T00:00:00Z</updated><summary>x</summary></entry></feed>`;
    const { fetcher } = fakeFetcher({ "https://www.cyber.gov.au/rss/alerts": atom, "https://www.cyber.gov.au/rss/advisories": atom });
    const res = await matchAdvisories(tdb.db, fetcher, {}, NOW);
    expect(res.signals).toBe(1);
    const [s] = await tdb.db.select().from(t.signals).where(and(eq(t.signals.accountId, accountId), eq(t.signals.channel, "cyber_advisory")));
    expect(s!.summary).toMatch(/Mentions NetScaler ADC/);
  });

  it("raises one quiet-customer alert per quiet key account", async () => {
    expect(await raiseQuietAlerts(tdb.db, NOW)).toBe(1);
    expect(await raiseQuietAlerts(tdb.db, NOW)).toBe(0);
  });
});
