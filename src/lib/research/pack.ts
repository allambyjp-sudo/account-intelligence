import type { Source } from "@/lib/db/schema";

/**
 * The sources a research run hands the model, numbered S1..Sn. The model cites by ref; code maps
 * refs back to source ids and drops any ref it didn't hand out. This is how "everything cited"
 * holds even when the model is wrong.
 */
export interface SourcePack {
  entries: Array<{ ref: string; source: Source; text: string }>;
  byRef: Map<string, Source>;
  /** The block that goes in the (cached) system prompt. */
  rendered: string;
}

const PER_TYPE_CAP: Partial<Record<Source["sourceType"], number>> = { report: 40_000, web: 12_000, careers_page: 10_000, registry: 4_000 };
const DEFAULT_CAP = 6_000;
const TOTAL_CAP = 160_000;
/** Registry and the company's own words first; news last, so the cap trims the least important text. */
const ORDER: Source["sourceType"][] = ["registry", "web", "report", "announcement", "careers_page", "job_ad", "case_study", "partner_directory", "tender", "advisory", "news", "market_data", "manual"];

export function buildPack(sources: Source[]): SourcePack {
  const sorted = [...sources].sort((a, b) => ORDER.indexOf(a.sourceType) - ORDER.indexOf(b.sourceType));
  const entries: SourcePack["entries"] = [];
  let used = 0;
  for (const source of sorted) {
    const body = (source.bodyText ?? source.excerpt ?? "").trim();
    if (!body) continue;
    const cap = Math.min(PER_TYPE_CAP[source.sourceType] ?? DEFAULT_CAP, TOTAL_CAP - used);
    if (cap < 300) break;
    const text = body.length > cap ? `${body.slice(0, cap)}\n[truncated]` : body;
    used += text.length;
    entries.push({ ref: `S${entries.length + 1}`, source, text });
  }
  const rendered = entries
    .map(({ ref, source, text }) =>
      [
        `<source ref="${ref}" type="${source.sourceType}" url="${source.url}"${source.publishedAt ? ` published="${source.publishedAt.toISOString().slice(0, 10)}"` : ""}>`,
        source.title ? `Title: ${source.title}` : null,
        source.publisher ? `Publisher: ${source.publisher}` : null,
        text,
        "</source>",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  return { entries, byRef: new Map(entries.map((e) => [e.ref, e.source])), rendered };
}
