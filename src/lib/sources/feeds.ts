import { XMLParser } from "fast-xml-parser";

/** One item from an RSS 2.0 or Atom feed, normalised. */
export interface FeedItem {
  title: string;
  url: string;
  publishedAt: Date | null;
  summary: string;
  /** RSS <source> (Google News uses it for the original publisher). */
  publisher: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  isArray: (name) => name === "item" || name === "entry" || name === "link",
});

const text = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object" && "#text" in (v as Record<string, unknown>)) return String((v as Record<string, unknown>)["#text"]);
  return "";
};

const date = (v: unknown): Date | null => {
  const s = text(v).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Parses RSS 2.0 or Atom. Unknown shapes return an empty list rather than throwing. */
export function parseFeed(xml: string): FeedItem[] {
  const doc = parser.parse(xml) as Record<string, any>;
  if (doc.rss?.channel) {
    const items: any[] = doc.rss.channel.item ?? [];
    return items
      .map((i) => ({
        title: stripTags(text(i.title)),
        url: text(i.link?.[0] ?? i.link).trim(),
        publishedAt: date(i.pubDate ?? i["dc:date"]),
        summary: stripTags(text(i.description)),
        publisher: text(i.source) || null,
      }))
      .filter((i) => i.url && i.title);
  }
  if (doc.feed) {
    const entries: any[] = doc.feed.entry ?? [];
    return entries
      .map((e) => {
        const links: any[] = e.link ?? [];
        const alt = links.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") ?? links[0];
        return {
          title: stripTags(text(e.title)),
          url: String(alt?.["@_href"] ?? "").trim(),
          publishedAt: date(e.published ?? e.updated),
          summary: stripTags(text(e.summary ?? e.content)),
          publisher: text(e.author?.name) || null,
        };
      })
      .filter((i) => i.url && i.title);
  }
  return [];
}

export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Does this text mention the company? Whole-word, case-insensitive, any of the terms. */
export function mentions(haystack: string, terms: string[]): boolean {
  return terms.some((t) => {
    const term = t.trim();
    if (term.length < 3) return false;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(haystack);
  });
}
