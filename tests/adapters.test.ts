import { describe, expect, it } from "vitest";
import { alphaVantageDaily, asxAnnouncements, austender, avSymbol } from "@/lib/sources/adapters/market";
import { configuredFeeds, googleNews, googleNewsUrl, loadFeeds, type FeedConfig } from "@/lib/sources/adapters/news";
import { abnDetails, abnSearch, asxCompanies, mergeCandidates, nzbnSearch, parseAsxCsv, parseJsonp, scoreMatch } from "@/lib/sources/adapters/registries";
import { careersPage, classifyLinks, contentHash, pdfReport, webPage } from "@/lib/sources/adapters/web";
import { detectFootprint } from "@/lib/sources/footprint";
import { mentions, parseFeed } from "@/lib/sources/feeds";
import { adapterStatuses } from "@/lib/sources/registry";
import { normaliseName, SourceDisabledError, SourceNotConfiguredError, sourceRecordSchema } from "@/lib/sources/types";
import { adapterContext, fakeFetcher } from "./helpers/fake-fetcher";

// Fixtures are shaped like each source's documented format. Company names and links are fictional.

const ABR = "https://abr.business.gov.au/json";

describe("ABN Lookup", () => {
  const names = `callback({"Message":"","Names":[
    {"Abn":"51824753556","AbnStatus":"0000000001","IsCurrent":true,"Name":"BELLBIRD LOGISTICS GROUP PTY LTD","NameType":"Entity Name","Postcode":"3000","Score":100,"State":"VIC"},
    {"Abn":"51824753556","AbnStatus":"0000000001","IsCurrent":true,"Name":"BELLBIRD FREIGHT","NameType":"Business Name","Postcode":"3000","Score":88,"State":"VIC"},
    {"Abn":"12345678901","AbnStatus":"0000000002","IsCurrent":false,"Name":"BELLBIRD LOGISTICS (OLD)","NameType":"Entity Name","Postcode":"2000","Score":80,"State":"NSW"}]})`;
  const details = `callback({"Abn":"51824753556","AbnStatus":"Active","AbnStatusEffectiveFrom":"2004-03-01","Acn":"123456789","AddressDate":"2020-01-01","AddressPostcode":"3000","AddressState":"VIC","BusinessName":["BELLBIRD FREIGHT"],"EntityName":"BELLBIRD LOGISTICS GROUP PTY LTD","EntityTypeCode":"PRV","EntityTypeName":"Australian Private Company","Gst":"2004-03-01","Message":""})`;

  it("parses JSONP", () => {
    expect(parseJsonp<{ a: number }>("callback({\"a\":1});")).toEqual({ a: 1 });
    expect(parseJsonp<{ a: number }>('{"a":2}')).toEqual({ a: 2 });
  });

  it("searches by name, one candidate per ABN, citing the public page rather than the API", async () => {
    const { fetcher, calls } = fakeFetcher({
      [`${ABR}/MatchingNames.aspx?name=Bellbird%20Logistics&maxResults=10&guid=g-123&callback=callback`]: names,
    });
    const out = await abnSearch.fetch({ name: "Bellbird Logistics" }, adapterContext(fetcher, { ABN_LOOKUP_GUID: "g-123" }));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ abn: "51824753556", legalName: "BELLBIRD LOGISTICS GROUP PTY LTD", state: "VIC", status: "Current" });
    expect(out[0]!.sourceUrl).toBe("https://abr.business.gov.au/ABN/View?abn=51824753556");
    expect(out.every((c) => !c.sourceUrl.includes("guid"))).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("returns a registry record for an ABN", async () => {
    const { fetcher } = fakeFetcher({ [`${ABR}/AbnDetails.aspx?abn=51824753556&guid=g-123&callback=callback`]: details });
    const rec = await abnDetails.fetch({ abn: "51824753556" }, adapterContext(fetcher, { ABN_LOOKUP_GUID: "g-123" }));
    expect(sourceRecordSchema.parse(rec)).toBeTruthy();
    expect(rec.meta).toMatchObject({ acn: "123456789", entityType: "Australian Private Company", state: "VIC" });
    expect(rec.text).toContain("Business names: BELLBIRD FREIGHT");
  });

  it("says plainly when the GUID isn't configured", async () => {
    const { fetcher } = fakeFetcher({});
    await expect(abnSearch.fetch({ name: "x" }, adapterContext(fetcher, {}))).rejects.toBeInstanceOf(SourceNotConfiguredError);
  });
});

describe("NZBN", () => {
  it("sends the subscription key as a header and ranks exact matches first", async () => {
    const body = JSON.stringify({
      items: [
        { nzbn: "9429000000001", entityName: "KOWHAI HEALTH SERVICES LIMITED", entityStatusDescription: "Registered", entityTypeDescription: "NZ Limited Company" },
        { nzbn: "9429000000002", entityName: "KŌWHAI HEALTH PARTNERS LIMITED", entityStatusDescription: "Registered", entityTypeDescription: "NZ Limited Company" },
      ],
    });
    const { fetcher, calls } = fakeFetcher({ "https://api.business.govt.nz/gateway/nzbn/v5/entities?search-term=K%C5%8Dwhai%20Health%20Partners&page-size=10": body });
    const out = await nzbnSearch.fetch({ name: "Kōwhai Health Partners" }, adapterContext(fetcher, { NZBN_API_KEY: "k" }));
    expect(calls[0]!.headers["Ocp-Apim-Subscription-Key"]).toBe("k");
    const best = out.sort((a, b) => b.score - a.score)[0]!;
    expect(best.nzbn).toBe("9429000000002");
    expect(best.sourceUrl).toBe("https://www.nzbn.govt.nz/mynzbn/nzbndetails/9429000000002/");
  });
});

describe("ASX listed companies", () => {
  const csv = `ASX listed companies as at Fri Oct 30 2026\r\n\r\nCompany name,ASX code,GICS industry group\r\n"SOUTHERN GRID ENERGY LIMITED","SGX","Utilities"\r\n"BELLBIRD LOGISTICS GROUP LTD","BLG","Transportation"\r\n"BELLBIRD MINERALS LTD","BBM","Materials"`;

  it("parses the CSV after its title lines", () => {
    expect(parseAsxCsv(csv)).toEqual([
      { name: "SOUTHERN GRID ENERGY LIMITED", code: "SGX", industry: "Utilities" },
      { name: "BELLBIRD LOGISTICS GROUP LTD", code: "BLG", industry: "Transportation" },
      { name: "BELLBIRD MINERALS LTD", code: "BBM", industry: "Materials" },
    ]);
  });

  it("matches by name or code", async () => {
    const { fetcher } = fakeFetcher({ "https://www.asx.com.au/asx/research/ASXListedCompanies.csv": csv });
    const byName = await asxCompanies.fetch({ name: "Bellbird Logistics Group" }, adapterContext(fetcher));
    expect(byName[0]).toMatchObject({ ticker: "BLG", exchange: "ASX", industry: "Transportation", score: 100 });
    const byCode = await asxCompanies.fetch({ name: "SGX" }, adapterContext(fetcher));
    expect(byCode[0]!.ticker).toBe("SGX");
  });

  it("merges a listing into its registry record", () => {
    const merged = mergeCandidates([
      [{ key: "abn:1", legalName: "Bellbird Logistics Group Ltd", country: "AU", abn: "51824753556", score: 95, sourceUrl: "https://abr.business.gov.au/ABN/View?abn=51824753556", adapter: "abn_lookup" }],
      [{ key: "asx:BLG", legalName: "BELLBIRD LOGISTICS GROUP LTD", country: "AU", ticker: "BLG", exchange: "ASX", industry: "Transportation", score: 100, sourceUrl: "https://www.asx.com.au/markets/company/BLG", adapter: "asx_companies" }],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ abn: "51824753556", ticker: "BLG", industry: "Transportation", score: 100 });
  });
});

describe("name matching", () => {
  it("ignores legal suffixes, punctuation and accents", () => {
    expect(normaliseName("Kōwhai Health Partners Limited")).toBe("kowhai health partners");
    expect(normaliseName("Bellbird Logistics Group Pty. Ltd.")).toBe("bellbird logistics");
    expect(scoreMatch("bellbird logistics", "bellbird logistics")).toBe(100);
    expect(scoreMatch("bellbird minerals", "southern grid")).toBe(0);
  });
});

describe("AusTender", () => {
  const page1 = JSON.stringify({
    releases: [
      {
        ocid: "prod-1",
        date: "2026-10-20T03:00:00Z",
        parties: [
          { name: "Department of Example Affairs", roles: ["procuringEntity"], additionalIdentifiers: [{ id: "11111111111", scheme: "AU-ABN" }] },
          { name: "BELLBIRD LOGISTICS GROUP PTY LTD", roles: ["supplier"], additionalIdentifiers: [{ id: "51824753556", scheme: "AU-ABN" }] },
        ],
        contracts: [{ id: "CN4000001", description: "Freight consolidation services", value: { amount: "1250000.00", currency: "AUD" }, period: { startDate: "2026-11-01", endDate: "2028-10-31" } }],
      },
      { ocid: "prod-2", parties: [{ name: "Someone Else Pty Ltd", roles: ["supplier"] }], contracts: [{ id: "CN4000002", description: "Catering" }] },
    ],
    links: { next: "https://api.tenders.gov.au/ocds/findByDates/contractPublished/2026-10-20T00:00:00Z/2026-10-21T00:00:00Z?cursor=2" },
  });
  const page2 = JSON.stringify({
    releases: [{ ocid: "prod-3", parties: [{ name: "Bellbird Logistics Group", roles: ["supplier"] }], contracts: [{ id: "CN4000003", title: "Warehousing" }] }],
  });

  it("follows pages, matches by ABN or name, and records role and value", async () => {
    const { fetcher } = fakeFetcher({
      "https://api.tenders.gov.au/ocds/findByDates/contractPublished/2026-10-20T00:00:00Z/2026-10-21T00:00:00Z": page1,
      "https://api.tenders.gov.au/ocds/findByDates/contractPublished/2026-10-20T00:00:00Z/2026-10-21T00:00:00Z?cursor=2": page2,
    });
    const out = await austender.fetch(
      { abn: "51824753556", names: ["bellbird logistics"], from: new Date("2026-10-20T00:00:00Z"), to: new Date("2026-10-21T00:00:00Z") },
      adapterContext(fetcher),
    );
    expect(out.map((r) => r.meta?.contractId)).toEqual(["CN4000001", "CN4000003"]);
    expect(out[0]!.meta).toMatchObject({ role: "supplier", amount: 1250000, agency: "Department of Example Affairs" });
    expect(out[0]!.text).toContain("AUD 1,250,000");
    expect(out[0]!.text).toContain("CC BY 3.0 AU");
  });
});

describe("feeds", () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
    <item><title>Bellbird Logistics names new CISO - Example Tech News</title><link>https://news.example/a</link><pubDate>Thu, 15 Oct 2026 01:00:00 GMT</pubDate><description>&lt;a href="https://news.example/a"&gt;Bellbird Logistics names new CISO&lt;/a&gt;</description><source url="https://news.example">Example Tech News</source></item>
    <item><title>Unrelated &amp; boring</title><link>https://news.example/b</link><pubDate>Thu, 15 Oct 2026 02:00:00 GMT</pubDate><description>Nothing here</description></item>
  </channel></rss>`;
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>
    <entry><title>Patch now: gateway flaw</title><link rel="alternate" href="https://advisories.example/1"/><updated>2026-10-28T00:00:00Z</updated><summary>Citrix NetScaler flaw exploited</summary></entry>
  </feed>`;

  it("parses RSS 2.0 and Atom", () => {
    const items = parseFeed(rss);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ url: "https://news.example/a", publisher: "Example Tech News" });
    expect(items[1]!.title).toBe("Unrelated & boring");
    expect(parseFeed(atom)[0]).toMatchObject({ url: "https://advisories.example/1", summary: "Citrix NetScaler flaw exploited" });
    expect(parseFeed("<html/>")).toEqual([]);
  });

  it("matches whole words only", () => {
    expect(mentions("Telstra outage", ["Telstra"])).toBe(true);
    expect(mentions("Telstras", ["Telstra"])).toBe(false);
    expect(mentions("anything", ["AB"])).toBe(false);
  });

  it("builds Google News queries for name, ticker and recency, and strips the publisher from titles", async () => {
    const q = { companyName: "Bellbird Logistics", ticker: "BLG", region: "AU" as const, days: 14 };
    const url = googleNewsUrl(q);
    expect(decodeURIComponent(url)).toContain('("Bellbird Logistics" OR "BLG") when:14d');
    expect(url).toContain("ceid=AU:en");
    const { fetcher } = fakeFetcher({ [url]: rss, [googleNewsUrl(q, "site:afr.com")]: rss });
    const out = await googleNews.fetch(q, adapterContext(fetcher));
    expect(out.map((r) => r.title)).toEqual(["Bellbird Logistics names new CISO", "Unrelated & boring"]);
  });

  it("filters configured feeds by mention and isolates broken feeds", async () => {
    const feeds: FeedConfig[] = [
      { id: "good", name: "Good", kind: "news", url: "https://feeds.example/good", region: "AU", verified: true, enabled: true },
      { id: "bad", name: "Bad", kind: "news", url: "https://feeds.example/bad", region: "AU", verified: true, enabled: true },
      { id: "off", name: "Off", kind: "news", url: "https://feeds.example/off", region: "AU", verified: true, enabled: false },
    ];
    const { fetcher, calls } = fakeFetcher({ "https://feeds.example/good": rss, "https://feeds.example/bad": { status: 404 } });
    const res = await configuredFeeds.fetch({ kind: "news", terms: ["Bellbird Logistics"], feeds }, adapterContext(fetcher));
    expect(res.records.map((r) => r.url)).toEqual(["https://news.example/a"]);
    expect(res.failures.map((f) => f.feed)).toEqual(["bad"]);
    expect(calls.some((c) => c.url.includes("off"))).toBe(false);
  });

  it("ships a valid feed list", () => {
    expect(loadFeeds().length).toBeGreaterThan(5);
  });
});

describe("web pages", () => {
  const html = `<!doctype html><html><head><title>Bellbird Logistics | Home</title><meta name="description" content="Freight and warehousing">
    <meta name="generator" content="WordPress 6.8"><script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>
    <script src="https://js.hs-scripts.com/123.js"></script></head>
    <body><nav><a href="/about-us">About us</a><a href="/our-leadership">Our leadership</a><a href="https://bellbird.myworkdayjobs.example.com/careers">Careers</a></nav>
    <main><h1>Moving the east coast</h1><p>2,400 people across 14 depots.</p><a href="/investors/annual-report">Annual report</a>
    <a href="https://login.microsoftonline.com/common/oauth2">Staff login</a></main><footer>© Bellbird</footer><script>var secret=1</script></body></html>`;

  it("extracts readable text, interesting links and the tech footprint", async () => {
    const { fetcher } = fakeFetcher({ "https://bellbird-logistics.example/": { body: html, headers: { "content-type": "text/html" } } });
    const res = await webPage.fetch({ url: "https://bellbird-logistics.example/", companyName: "Bellbird" }, adapterContext(fetcher));
    expect(res.record.text).toContain("2,400 people across 14 depots.");
    expect(res.record.text).not.toContain("var secret");
    expect(res.record.text).not.toContain("© Bellbird");
    expect(res.interestingLinks.map((l) => l.kind).sort()).toEqual(["about", "investors", "leadership"]);
    expect(res.footprint.map((f) => `${f.vendor} ${f.product}`).sort()).toEqual([
      "Google Analytics",
      "HubSpot HubSpot",
      "Microsoft Entra ID (sign-in)",
      "WordPress WordPress",
    ]);
  });

  it("detects footprint markers without false positives on plain text", () => {
    expect(detectFootprint(["https://cdn.example/app.js"])).toEqual([]);
    expect(detectFootprint(["https://d1.cloudfront.net/x.js"])[0]!.vendor).toBe("AWS");
  });

  it("keeps only same-site links", () => {
    const links = classifyLinks([{ href: "https://elsewhere.example/about", text: "About" }], "https://bellbird-logistics.example/");
    expect(links).toEqual([]);
  });

  it("hashes careers pages by text so cosmetic changes don't count", async () => {
    expect(contentHash("Cloud engineer\n\n Data analyst")).toBe(contentHash("Cloud engineer Data analyst"));
    const page = (role: string) => `<html><body><main><h2>${role}</h2></main><script>var t=${Math.random()}</script></body></html>`;
    const { fetcher } = fakeFetcher({ "https://bellbird-logistics.example/careers": page("Cloud Platform Engineer") });
    const a = await careersPage.fetch({ url: "https://bellbird-logistics.example/careers", companyName: "Bellbird" }, adapterContext(fetcher));
    expect(a.record.contentHash).toBe(contentHash("Cloud Platform Engineer"));
  });
});

describe("PDF reports", () => {
  // A minimal one-page PDF with the text "Annual report 2026".
  const pdf = (() => {
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      null,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    const stream = "BT /F1 18 Tf 20 70 Td (Annual report 2026) Tj ET";
    objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    objs.forEach((o, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return new TextEncoder().encode(out);
  })();

  it("extracts text page by page", async () => {
    const { fetcher } = fakeFetcher({ "https://bellbird-logistics.example/ar2026.pdf": { body: pdf, headers: { "content-type": "application/pdf" } } });
    const [rec] = await pdfReport.fetch({ url: "https://bellbird-logistics.example/ar2026.pdf", companyName: "Bellbird" }, adapterContext(fetcher));
    expect(rec!.text).toContain("[page 1]");
    expect(rec!.text).toContain("Annual report 2026");
    expect(rec!.meta).toEqual({ pages: 1 });
  });
});

describe("ASX announcements", () => {
  it("is off until its terms are checked", async () => {
    const { fetcher } = fakeFetcher({});
    await expect(asxAnnouncements.fetch({ ticker: "BLG", companyName: "x" }, adapterContext(fetcher))).rejects.toBeInstanceOf(SourceDisabledError);
  });

  it("parses announcements once enabled", async () => {
    const body = JSON.stringify({ data: { items: [{ headline: "Half Year Results", date: "2026-08-20T09:30:00+10:00", documentKey: "2924-0001", isPriceSensitive: true, announcementTypes: ["Periodic Reports"] }] } });
    const { fetcher } = fakeFetcher({ "https://asx.api.markitdigital.com/asx-research/1.0/companies/blg/announcements": body });
    const [a] = await asxAnnouncements.fetch({ ticker: "BLG", companyName: "Bellbird" }, adapterContext(fetcher, { SOURCES_ENABLED: "asx_announcements" }));
    expect(a).toMatchObject({ title: "Half Year Results", sourceType: "announcement", meta: { priceSensitive: true } });
  });
});

describe("Alpha Vantage", () => {
  it("maps tickers to exchange symbols, configurable", () => {
    expect(avSymbol("ASX", "blg", {})).toBe("BLG.AX");
    expect(avSymbol("NZX", "KHP", { ALPHA_VANTAGE_SUFFIX_NZX: ".NZX" })).toBe("KHP.NZX");
  });

  it("parses daily closes oldest first, never storing the key in the citation", async () => {
    const body = JSON.stringify({
      "Meta Data": { "2. Symbol": "BLG.AX" },
      "Time Series (Daily)": { "2026-10-29": { "4. close": "4.10" }, "2026-10-30": { "4. close": "4.25" } },
    });
    const { fetcher } = fakeFetcher({ "https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=BLG.AX&outputsize=compact&apikey=secret": body });
    const s = await alphaVantageDaily.fetch({ exchange: "ASX", ticker: "BLG", companyName: "Bellbird" }, adapterContext(fetcher, { ALPHA_VANTAGE_API_KEY: "secret" }));
    expect(s.points).toEqual([
      { tradeDate: "2026-10-29", close: 4.1 },
      { tradeDate: "2026-10-30", close: 4.25 },
    ]);
    expect(s.record.url).not.toContain("secret");
  });

  it("surfaces rate-limit notes as errors", async () => {
    const { fetcher } = fakeFetcher({
      "https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=BLG.AX&outputsize=compact&apikey=k": JSON.stringify({ Note: "Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day." }),
    });
    await expect(alphaVantageDaily.fetch({ exchange: "ASX", ticker: "BLG", companyName: "B" }, adapterContext(fetcher, { ALPHA_VANTAGE_API_KEY: "k" }))).rejects.toThrow(/rate limit/);
  });
});

describe("adapter registry", () => {
  it("reports which sources are enabled and configured", () => {
    const s = adapterStatuses({ ABN_LOOKUP_GUID: "x", SOURCES_DISABLED: "google_news" });
    expect(s.find((a) => a.id === "abn_lookup")).toMatchObject({ enabled: true, configured: true });
    expect(s.find((a) => a.id === "nzbn")).toMatchObject({ configured: false });
    expect(s.find((a) => a.id === "google_news")!.enabled).toBe(false);
    expect(s.find((a) => a.id === "asx_announcements")!.enabled).toBe(false);
  });
});
