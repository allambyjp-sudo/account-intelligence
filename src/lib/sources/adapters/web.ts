import { createHash } from "node:crypto";
import { detectFootprint, type FootprintHit } from "../footprint";
import { extractPage } from "../html";
import { capText, requireReady, type AdapterInfo, type SourceAdapter, type SourceRecord } from "../types";

// ---------------------------------------------------------------------------------------------
// Company web pages (home, about, leadership, case studies), with tech footprint
// ---------------------------------------------------------------------------------------------

export const WEB_PAGE: AdapterInfo = {
  id: "web_page",
  description: "A public web page: readable text, plus the vendors visible in its scripts and links.",
  hosts: [],
  formatVerified: true,
  termsNote: "Ordinary websites: robots.txt and Crawl-delay are honoured by the fetch layer, one request every 2 seconds per host by default.",
  defaultEnabled: true,
};

export interface WebPageResult {
  record: SourceRecord;
  footprint: FootprintHit[];
  /** Same-site links worth following (about, leadership, careers, investors, case studies). */
  interestingLinks: Array<{ href: string; text: string; kind: LinkKind }>;
}

export type LinkKind = "about" | "leadership" | "careers" | "investors" | "case_study" | "news";

const LINK_PATTERNS: Array<[LinkKind, RegExp]> = [
  ["leadership", /\b(leadership|executive|management team|our (people|team)|board of directors|board)\b/i],
  ["careers", /\b(careers?|jobs|work (with|for) us|join us|vacancies)\b/i],
  ["investors", /\b(investors?|annual report|shareholders?|asx announcements)\b/i],
  ["about", /\b(about( us)?|who we are|our (company|story|history))\b/i],
  ["case_study", /\b(case stud(y|ies)|customer stor(y|ies))\b/i],
  ["news", /\b(news(room)?|media( releases?)?|press)\b/i],
];

export function classifyLinks(links: Array<{ href: string; text: string }>, baseUrl: string): WebPageResult["interestingLinks"] {
  const host = new URL(baseUrl).host.replace(/^www\./, "");
  const seen = new Set<string>();
  const out: WebPageResult["interestingLinks"] = [];
  for (const l of links) {
    let u: URL;
    try {
      u = new URL(l.href);
    } catch {
      continue;
    }
    if (u.host.replace(/^www\./, "") !== host) continue;
    u.hash = "";
    const label = `${l.text} ${u.pathname.replace(/[-_/]/g, " ")}`;
    const kind = LINK_PATTERNS.find(([, re]) => re.test(label))?.[0];
    if (!kind || seen.has(u.href)) continue;
    seen.add(u.href);
    out.push({ href: u.href, text: l.text, kind });
  }
  return out.slice(0, 20);
}

export const webPage: SourceAdapter<{ url: string; companyName: string; sourceType?: SourceRecord["sourceType"] }, WebPageResult> = {
  info: WEB_PAGE,
  async fetch({ url, companyName, sourceType = "web" }, ctx) {
    requireReady(WEB_PAGE, ctx.env);
    const res = await ctx.fetcher.get(url, { headers: { accept: "text/html,application/xhtml+xml" } });
    const page = extractPage(res.text(), res.url);
    const text = capText([page.title, page.description, page.text].filter(Boolean).join("\n\n"), 60_000);
    return {
      record: {
        adapter: WEB_PAGE.id,
        sourceType,
        url: res.url,
        title: page.title,
        publisher: new URL(res.url).host.replace(/^www\./, ""),
        publishedAt: null,
        retrievedAt: res.fetchedAt,
        entities: [{ name: companyName, domain: new URL(res.url).host.replace(/^www\./, "") }],
        text,
      },
      footprint: detectFootprint([...page.assetUrls, ...page.links.map((l) => l.href)], page.generator),
      interestingLinks: classifyLinks(page.links, res.url),
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Careers page with change detection
// ---------------------------------------------------------------------------------------------

export const CAREERS_PAGE: AdapterInfo = {
  id: "careers_page",
  description: "The company's own careers page. Each distinct version is kept, so new tech roles show up as changes.",
  hosts: [],
  formatVerified: true,
  termsNote: "Company's own site; robots.txt honoured. Seek and LinkedIn aren't scraped (their terms prohibit it).",
  defaultEnabled: true,
};

/** Hash of the page's text, not its HTML, so tracking scripts and timestamps don't count as changes. */
export const contentHash = (text: string) => createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");

export const careersPage: SourceAdapter<{ url: string; companyName: string }, { record: SourceRecord; footprint: FootprintHit[] }> = {
  info: CAREERS_PAGE,
  async fetch({ url, companyName }, ctx) {
    requireReady(CAREERS_PAGE, ctx.env);
    // Revalidate every time: change detection needs the current version, not a cached one.
    const res = await ctx.fetcher.get(url, { revalidate: true, headers: { accept: "text/html,application/xhtml+xml" } });
    const page = extractPage(res.text(), res.url);
    const text = capText([page.title, page.text].filter(Boolean).join("\n\n"), 60_000);
    return {
      record: {
        adapter: CAREERS_PAGE.id,
        sourceType: "careers_page",
        url: res.url,
        title: page.title ?? `${companyName} careers`,
        publisher: new URL(res.url).host.replace(/^www\./, ""),
        publishedAt: null,
        retrievedAt: res.fetchedAt,
        entities: [{ name: companyName }],
        text,
        contentHash: contentHash(page.text),
      },
      footprint: detectFootprint([...page.assetUrls, ...page.links.map((l) => l.href)], page.generator),
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Annual and half-year reports (PDF)
// ---------------------------------------------------------------------------------------------

export const PDF_REPORT: AdapterInfo = {
  id: "pdf_report",
  description: "Annual and half-year reports and other PDFs: text extracted page by page.",
  hosts: [],
  formatVerified: true,
  termsNote: "Published reports on the company's or the exchange's site; robots.txt honoured.",
  defaultEnabled: true,
};

export async function pdfToText(bytes: Uint8Array): Promise<{ pages: number; text: string }> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  return { pages: totalPages, text: text.map((t, i) => `[page ${i + 1}]\n${t}`).join("\n\n") };
}

export const pdfReport: SourceAdapter<{ url: string; companyName: string; title?: string }> = {
  info: PDF_REPORT,
  async fetch({ url, companyName, title }, ctx) {
    requireReady(PDF_REPORT, ctx.env);
    const res = await ctx.fetcher.get(url, { headers: { accept: "application/pdf" }, ttlMs: 30 * 86_400_000 });
    const { pages, text } = await pdfToText(new Uint8Array(res.body));
    return [
      {
        adapter: PDF_REPORT.id,
        sourceType: "report",
        url: res.url,
        title: title ?? decodeURIComponent(new URL(res.url).pathname.split("/").pop() ?? "Report"),
        publisher: new URL(res.url).host.replace(/^www\./, ""),
        publishedAt: null,
        retrievedAt: res.fetchedAt,
        entities: [{ name: companyName }],
        text: capText(text),
        meta: { pages },
      },
    ];
  },
};
