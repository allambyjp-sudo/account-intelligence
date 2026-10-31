import { requireReady, type AdapterInfo, type SourceAdapter, type SourceRecord } from "../types";

// ---------------------------------------------------------------------------------------------
// ASX company announcements
// ---------------------------------------------------------------------------------------------

export const ASX_ANNOUNCEMENTS: AdapterInfo = {
  id: "asx_announcements",
  description: "Company announcements lodged with the ASX, per ticker.",
  hosts: ["asx.api.markitdigital.com", "cdn-api.markitdigital.com"],
  formatVerified: false,
  termsNote:
    "ASX's website reads announcements from an unpublished JSON API. Off until ASX's website terms have been read and allow this; the ASX's licensed data feeds are the paid alternative.",
  defaultEnabled: false,
};

interface MarkitAnnouncements {
  data?: {
    items?: Array<{
      headline: string;
      date: string;
      documentKey: string;
      isPriceSensitive?: boolean;
      announcementTypes?: string[];
      fileSize?: string;
    }>;
  };
}

export const asxAnnouncements: SourceAdapter<{ ticker: string; companyName: string; limit?: number }> = {
  info: ASX_ANNOUNCEMENTS,
  async fetch({ ticker, companyName, limit = 20 }, ctx) {
    requireReady(ASX_ANNOUNCEMENTS, ctx.env);
    const code = ticker.toLowerCase();
    const res = await ctx.fetcher.get(`https://asx.api.markitdigital.com/asx-research/1.0/companies/${code}/announcements`, { ttlMs: 30 * 60_000 });
    const items = res.json<MarkitAnnouncements>().data?.items ?? [];
    return items.slice(0, limit).map((a) => {
      const types = a.announcementTypes?.join(", ");
      return {
        adapter: ASX_ANNOUNCEMENTS.id,
        sourceType: "announcement",
        url: `https://cdn-api.markitdigital.com/apiman-gateway/ASX/asx-research/1.0/file/${a.documentKey}`,
        title: a.headline,
        publisher: "ASX",
        publishedAt: new Date(a.date),
        retrievedAt: res.fetchedAt,
        entities: [{ name: companyName, ticker: ticker.toUpperCase() }],
        text: [a.headline, types ? `Type: ${types}` : null, a.isPriceSensitive ? "Market sensitive" : null].filter(Boolean).join("\n"),
        meta: { priceSensitive: Boolean(a.isPriceSensitive), types: a.announcementTypes ?? [] },
      } satisfies SourceRecord;
    });
  },
};

// ---------------------------------------------------------------------------------------------
// AusTender contract notices (OCDS API)
// ---------------------------------------------------------------------------------------------

export const AUSTENDER: AdapterInfo = {
  id: "austender",
  description: "Australian Government contract notices (AusTender, Open Contracting Data Standard).",
  hosts: ["api.tenders.gov.au"],
  formatVerified: false,
  termsNote: "Official open-data API, no key. Data under CC BY 3.0 AU: attribute AusTender when shown. Paths confirmed from the AusTender OCDS repository; release shape follows OCDS 1.1.",
  defaultEnabled: true,
};

interface OcdsIdentifier {
  id?: string;
  scheme?: string;
}
interface OcdsParty {
  id?: string;
  name?: string;
  roles?: string[];
  identifier?: OcdsIdentifier;
  additionalIdentifiers?: OcdsIdentifier[];
}
interface OcdsRelease {
  ocid?: string;
  id?: string;
  date?: string;
  parties?: OcdsParty[];
  contracts?: Array<{
    id?: string;
    title?: string;
    description?: string;
    value?: { amount?: number | string; currency?: string };
    period?: { startDate?: string; endDate?: string };
    dateSigned?: string;
    items?: Array<{ description?: string; classification?: { description?: string } }>;
  }>;
  tender?: { title?: string; description?: string; procurementMethodDetails?: string };
}
interface OcdsPage {
  releases?: OcdsRelease[];
  links?: { next?: string };
}

export interface AusTenderQuery {
  /** ABN of the account's entity, matched as supplier or buyer. */
  abn?: string;
  /** Normalised names to match when a party has no ABN. */
  names: string[];
  from: Date;
  to: Date;
  maxPages?: number;
}

const abnOf = (p: OcdsParty) =>
  [p.identifier, ...(p.additionalIdentifiers ?? [])].find((i) => i?.scheme?.toUpperCase().includes("ABN") && i.id)?.id?.replace(/\s/g, "");

export const austender: SourceAdapter<AusTenderQuery> = {
  info: AUSTENDER,
  async fetch({ abn, names, from, to, maxPages = 10 }, ctx) {
    requireReady(AUSTENDER, ctx.env);
    const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
    let url: string | undefined = `https://api.tenders.gov.au/ocds/findByDates/contractPublished/${iso(from)}/${iso(to)}`;
    const wanted = names.map((n) => n.toLowerCase()).filter((n) => n.length >= 3);
    const out: SourceRecord[] = [];

    for (let page = 0; url && page < maxPages; page++) {
      const res = await ctx.fetcher.get(url, { ttlMs: 12 * 3_600_000 });
      const body = res.json<OcdsPage>();
      for (const r of body.releases ?? []) {
        const parties = r.parties ?? [];
        const match = parties.find((p) => (abn && abnOf(p) === abn) || (p.name && wanted.some((w) => p.name!.toLowerCase().includes(w))));
        if (!match) continue;
        const contract = r.contracts?.[0];
        const cn = contract?.id ?? r.id ?? r.ocid ?? "unknown";
        const role = match.roles?.includes("supplier") ? "supplier" : match.roles?.includes("buyer") || match.roles?.includes("procuringEntity") ? "buyer" : "party";
        const buyer = parties.find((p) => p.roles?.some((x) => x === "buyer" || x === "procuringEntity"));
        const supplier = parties.find((p) => p.roles?.includes("supplier"));
        const amount = contract?.value?.amount != null ? Number(contract.value.amount) : null;
        const what = contract?.description ?? contract?.title ?? r.tender?.description ?? contract?.items?.[0]?.description ?? "Contract notice";
        out.push({
          adapter: AUSTENDER.id,
          sourceType: "tender",
          url: `https://api.tenders.gov.au/ocds/findById/${encodeURIComponent(cn)}`,
          title: `${cn}: ${what}`.slice(0, 300),
          publisher: "AusTender",
          publishedAt: r.date ? new Date(r.date) : null,
          retrievedAt: res.fetchedAt,
          entities: parties.filter((p) => p.name).map((p) => ({ name: p.name!, ...(abnOf(p) ? { abn: abnOf(p)! } : {}) })),
          text: [
            `Contract notice ${cn}`,
            `Description: ${what}`,
            buyer?.name ? `Agency: ${buyer.name}` : null,
            supplier?.name ? `Supplier: ${supplier.name}` : null,
            amount != null && !Number.isNaN(amount) ? `Value: ${contract?.value?.currency ?? "AUD"} ${amount.toLocaleString("en-AU")}` : null,
            contract?.period?.startDate ? `Period: ${contract.period.startDate.slice(0, 10)} to ${contract.period.endDate?.slice(0, 10) ?? "?"}` : null,
            contract?.items?.[0]?.classification?.description ? `Category: ${contract.items[0].classification.description}` : null,
            "Source: AusTender (CC BY 3.0 AU)",
          ]
            .filter(Boolean)
            .join("\n"),
          meta: { role, amount, currency: contract?.value?.currency ?? "AUD", contractId: cn, agency: buyer?.name ?? null },
        });
      }
      url = body.links?.next;
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// Share price (Alpha Vantage free tier)
// ---------------------------------------------------------------------------------------------

export const ALPHA_VANTAGE: AdapterInfo = {
  id: "alpha_vantage",
  description: "Daily closing prices for listed accounts (Alpha Vantage free tier).",
  hosts: ["www.alphavantage.co"],
  formatVerified: false,
  termsNote: "Free key; about 25 requests a day and 5 a minute. ASX/NZX symbol suffixes (ALPHA_VANTAGE_SUFFIX_ASX, _NZX) need a live test before relying on them.",
  credential: "ALPHA_VANTAGE_API_KEY",
  defaultEnabled: true,
};

export interface PricePoint {
  tradeDate: string;
  close: number;
}

export interface PriceSeries {
  symbol: string;
  currency: string;
  points: PricePoint[];
  record: SourceRecord;
}

interface AvDaily {
  "Meta Data"?: Record<string, string>;
  "Time Series (Daily)"?: Record<string, Record<string, string>>;
  Note?: string;
  Information?: string;
  "Error Message"?: string;
}

export function avSymbol(exchange: "ASX" | "NZX", ticker: string, env: Record<string, string | undefined>): string {
  const suffix = exchange === "ASX" ? (env.ALPHA_VANTAGE_SUFFIX_ASX ?? ".AX") : (env.ALPHA_VANTAGE_SUFFIX_NZX ?? ".NZ");
  return `${ticker.toUpperCase()}${suffix}`;
}

export const alphaVantageDaily: SourceAdapter<{ exchange: "ASX" | "NZX"; ticker: string; companyName: string }, PriceSeries> = {
  info: ALPHA_VANTAGE,
  async fetch({ exchange, ticker, companyName }, ctx) {
    const key = requireReady(ALPHA_VANTAGE, ctx.env)!;
    const symbol = avSymbol(exchange, ticker, ctx.env);
    const res = await ctx.fetcher.get(
      `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&outputsize=compact&apikey=${encodeURIComponent(key)}`,
      { ttlMs: 12 * 3_600_000 },
    );
    const body = res.json<AvDaily>();
    const problem = body["Error Message"] ?? body.Note ?? body.Information;
    if (problem || !body["Time Series (Daily)"]) throw new Error(`Alpha Vantage (${symbol}): ${problem ?? "no time series in response"}`);
    const points = Object.entries(body["Time Series (Daily)"])
      .map(([tradeDate, v]) => ({ tradeDate, close: Number(v["4. close"]) }))
      .filter((p) => Number.isFinite(p.close))
      .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
    const currency = exchange === "ASX" ? "AUD" : "NZD";
    const last = points.at(-1);
    return {
      symbol,
      currency,
      points,
      record: {
        adapter: ALPHA_VANTAGE.id,
        sourceType: "market_data",
        // A public page for people; the API URL carries the key and is never stored.
        url: exchange === "ASX" ? `https://www.asx.com.au/markets/company/${ticker.toUpperCase()}` : `https://www.nzx.com/instruments/${ticker.toUpperCase()}`,
        title: `${companyName} daily closing prices`,
        publisher: "Alpha Vantage",
        publishedAt: last ? new Date(`${last.tradeDate}T00:00:00Z`) : null,
        retrievedAt: res.fetchedAt,
        entities: [{ name: companyName, ticker: ticker.toUpperCase() }],
        text: last ? `${symbol} closed at ${currency} ${last.close} on ${last.tradeDate}.` : `${symbol}: no prices`,
      },
    };
  },
};
