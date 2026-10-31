import type { IntakeCandidate } from "@/lib/db/schema";
import { normaliseName, requireReady, type AdapterContext, type AdapterInfo, type SourceAdapter, type SourceRecord } from "../types";

// ---------------------------------------------------------------------------------------------
// ABN Lookup (Australian Business Register JSON web services)
// ---------------------------------------------------------------------------------------------

export const ABN_LOOKUP: AdapterInfo = {
  id: "abn_lookup",
  description: "Australian Business Register: legal name, ABN/ACN, status, entity type and location.",
  hosts: ["abr.business.gov.au"],
  formatVerified: false,
  termsNote: "Free ABR web services; register for a GUID. Citations use the public ABN Lookup page, never the API URL (it carries the GUID).",
  credential: "ABN_LOOKUP_GUID",
  defaultEnabled: true,
};

const ABR_BASE = "https://abr.business.gov.au/json";

/** ABR JSON endpoints answer as JSONP: callback({...}). */
export function parseJsonp<T>(body: string): T {
  const m = /^[^(]*\(([\s\S]*)\)\s*;?\s*$/.exec(body.trim());
  return JSON.parse(m ? m[1]! : body) as T;
}

interface AbrNames {
  Message: string;
  Names: Array<{ Abn: string; AbnStatus: string; IsCurrent: boolean; Name: string; NameType: string; Postcode: string; Score: number; State: string }>;
}

interface AbrDetails {
  Abn: string;
  AbnStatus: string;
  AbnStatusEffectiveFrom: string;
  Acn: string;
  AddressDate: string | null;
  AddressPostcode: string;
  AddressState: string;
  BusinessName: string[];
  EntityName: string;
  EntityTypeCode: string;
  EntityTypeName: string;
  Gst: string | null;
  Message: string;
}

export const abnPublicUrl = (abn: string) => `https://abr.business.gov.au/ABN/View?abn=${abn}`;

export const abnSearch: SourceAdapter<{ name: string; max?: number }, IntakeCandidate[]> = {
  info: ABN_LOOKUP,
  async fetch({ name, max = 10 }, ctx) {
    const guid = requireReady(ABN_LOOKUP, ctx.env)!;
    const url = `${ABR_BASE}/MatchingNames.aspx?name=${encodeURIComponent(name)}&maxResults=${max}&guid=${encodeURIComponent(guid)}&callback=callback`;
    const res = parseJsonp<AbrNames>((await ctx.fetcher.get(url)).text());
    if (res.Message) throw new Error(`ABN Lookup: ${res.Message}`);
    // The same ABN appears once per name (entity, trading, business names); keep its best-scoring row.
    const best = new Map<string, AbrNames["Names"][number]>();
    for (const n of res.Names ?? []) {
      const prev = best.get(n.Abn);
      if (!prev || n.Score > prev.Score || (n.NameType === "Entity Name" && n.Score === prev.Score)) best.set(n.Abn, n);
    }
    return [...best.values()].map((n) => ({
      key: `abn:${n.Abn}`,
      legalName: n.Name,
      country: "AU" as const,
      abn: n.Abn,
      state: n.State || undefined,
      postcode: n.Postcode || undefined,
      status: n.IsCurrent ? "Current" : "Not current",
      score: n.Score,
      sourceUrl: abnPublicUrl(n.Abn),
      adapter: ABN_LOOKUP.id,
    }));
  },
};

export const abnDetails: SourceAdapter<{ abn: string }, SourceRecord> = {
  info: ABN_LOOKUP,
  async fetch({ abn }, ctx) {
    const guid = requireReady(ABN_LOOKUP, ctx.env)!;
    const url = `${ABR_BASE}/AbnDetails.aspx?abn=${abn}&guid=${encodeURIComponent(guid)}&callback=callback`;
    const res = await ctx.fetcher.get(url);
    const d = parseJsonp<AbrDetails>(res.text());
    if (d.Message) throw new Error(`ABN Lookup: ${d.Message}`);
    const lines = [
      `Entity name: ${d.EntityName}`,
      `ABN: ${d.Abn} (${d.AbnStatus} from ${d.AbnStatusEffectiveFrom})`,
      d.Acn ? `ACN: ${d.Acn}` : null,
      `Entity type: ${d.EntityTypeName}`,
      `Main business location: ${d.AddressState} ${d.AddressPostcode}`,
      d.Gst ? `Registered for GST from ${d.Gst}` : "Not registered for GST",
      d.BusinessName?.length ? `Business names: ${d.BusinessName.join("; ")}` : null,
    ].filter(Boolean);
    return {
      adapter: ABN_LOOKUP.id,
      sourceType: "registry",
      url: abnPublicUrl(d.Abn),
      title: `ABN Lookup: ${d.EntityName}`,
      publisher: "Australian Business Register",
      publishedAt: null,
      retrievedAt: res.fetchedAt,
      entities: [{ name: d.EntityName, abn: d.Abn }],
      text: lines.join("\n"),
      meta: {
        abn: d.Abn,
        acn: d.Acn || null,
        legalName: d.EntityName,
        entityType: d.EntityTypeName,
        status: d.AbnStatus,
        state: d.AddressState,
        postcode: d.AddressPostcode,
        businessNames: d.BusinessName ?? [],
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------
// NZBN (New Zealand Business Number register)
// ---------------------------------------------------------------------------------------------

export const NZBN: AdapterInfo = {
  id: "nzbn",
  description: "New Zealand Business Number register: legal name, NZBN, status and entity type.",
  hosts: ["api.business.govt.nz"],
  formatVerified: false,
  termsNote: "Free NZBN API via api.business.govt.nz; register for a subscription key. Version and paths to confirm on first live run (NZBN_API_BASE overrides).",
  credential: "NZBN_API_KEY",
  defaultEnabled: true,
};

interface NzbnSearch {
  items?: Array<{
    nzbn: string;
    entityName: string;
    entityStatusDescription?: string;
    entityTypeDescription?: string;
    registrationDate?: string;
  }>;
}

export const nzbnPublicUrl = (nzbn: string) => `https://www.nzbn.govt.nz/mynzbn/nzbndetails/${nzbn}/`;
const nzbnBase = (env: Record<string, string | undefined>) => env.NZBN_API_BASE ?? "https://api.business.govt.nz/gateway/nzbn/v5";

export const nzbnSearch: SourceAdapter<{ name: string; max?: number }, IntakeCandidate[]> = {
  info: NZBN,
  async fetch({ name, max = 10 }, ctx) {
    const key = requireReady(NZBN, ctx.env)!;
    const url = `${nzbnBase(ctx.env)}/entities?search-term=${encodeURIComponent(name)}&page-size=${max}`;
    const res = (await ctx.fetcher.get(url, { headers: { "Ocp-Apim-Subscription-Key": key, accept: "application/json" } })).json<NzbnSearch>();
    const target = normaliseName(name);
    return (res.items ?? []).map((i) => ({
      key: `nzbn:${i.nzbn}`,
      legalName: i.entityName,
      country: "NZ" as const,
      nzbn: i.nzbn,
      entityType: i.entityTypeDescription,
      status: i.entityStatusDescription,
      // The NZBN search doesn't score results; rank exact normalised matches first.
      score: normaliseName(i.entityName) === target ? 100 : 80,
      sourceUrl: nzbnPublicUrl(i.nzbn),
      adapter: NZBN.id,
    }));
  },
};

// ---------------------------------------------------------------------------------------------
// ASX listed companies (official CSV)
// ---------------------------------------------------------------------------------------------

export const ASX_COMPANIES: AdapterInfo = {
  id: "asx_companies",
  description: "ASX's list of listed companies: name, ASX code and GICS industry group.",
  hosts: ["www.asx.com.au"],
  formatVerified: false,
  termsNote: "Public CSV published by ASX for download. URL to confirm on first live run (ASX_COMPANIES_CSV_URL overrides).",
  defaultEnabled: true,
};

export interface ListedCompany {
  name: string;
  code: string;
  industry: string;
}

/** Parses ASX's CSV: a title line, a blank line, then "Company name","ASX code","GICS industry group". */
export function parseAsxCsv(csv: string): ListedCompany[] {
  const rows = csv.split(/\r?\n/).map(parseCsvLine);
  const header = rows.findIndex((r) => r[0]?.toLowerCase() === "company name");
  if (header < 0) return [];
  return rows
    .slice(header + 1)
    .filter((r) => r.length >= 2 && r[0] && r[1])
    .map((r) => ({ name: r[0]!, code: r[1]!.toUpperCase(), industry: r[2] ?? "" }));
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

export const asxCompanies: SourceAdapter<{ name: string; max?: number }, IntakeCandidate[]> = {
  info: ASX_COMPANIES,
  async fetch({ name, max = 5 }, ctx) {
    requireReady(ASX_COMPANIES, ctx.env);
    const url = ctx.env.ASX_COMPANIES_CSV_URL ?? "https://www.asx.com.au/asx/research/ASXListedCompanies.csv";
    const res = await ctx.fetcher.get(url, { ttlMs: 7 * 86_400_000 });
    const target = normaliseName(name);
    const code = name.trim().toUpperCase();
    return parseAsxCsv(res.text())
      .map((c) => ({ c, score: scoreMatch(normaliseName(c.name), target, c.code === code) }))
      .filter((m) => m.score >= 60)
      .sort((a, b) => b.score - a.score)
      .slice(0, max)
      .map(({ c, score }) => ({
        key: `asx:${c.code}`,
        legalName: c.name,
        country: "AU" as const,
        exchange: "ASX" as const,
        ticker: c.code,
        industry: c.industry || undefined,
        score,
        sourceUrl: `https://www.asx.com.au/markets/company/${c.code}`,
        adapter: ASX_COMPANIES.id,
      }));
  },
};

/** 100 exact, 90 code match, 80 prefix, 60–75 word overlap. */
export function scoreMatch(candidate: string, target: string, codeMatch = false): number {
  if (!candidate || !target) return 0;
  if (candidate === target) return 100;
  if (codeMatch) return 90;
  if (candidate.startsWith(target) || target.startsWith(candidate)) return 80;
  const a = new Set(candidate.split(" "));
  const b = target.split(" ");
  const overlap = b.filter((w) => a.has(w)).length / Math.max(a.size, b.length);
  return overlap >= 0.5 ? Math.round(60 + overlap * 15) : 0;
}

/**
 * Combines registry and exchange candidates: an ASX listing whose name matches an ABN record is
 * merged into it, so the picker shows "Acme Ltd · ABN … · ASX:ACM" as one choice.
 */
export function mergeCandidates(lists: IntakeCandidate[][]): IntakeCandidate[] {
  const out: IntakeCandidate[] = [];
  for (const c of lists.flat()) {
    const twin = out.find((o) => o.country === c.country && normaliseName(o.legalName) === normaliseName(c.legalName));
    if (twin) {
      Object.assign(twin, { ...c, ...twin, ticker: twin.ticker ?? c.ticker, exchange: twin.exchange ?? c.exchange, industry: twin.industry ?? c.industry });
      twin.score = Math.max(twin.score, c.score);
    } else out.push({ ...c });
  }
  return out.sort((a, b) => b.score - a.score);
}

export type { AdapterContext };
