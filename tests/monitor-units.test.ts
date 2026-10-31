import { describe, expect, it } from "vitest";
import { advisoryMatches, stackTerms } from "@/lib/monitor/advisories";
import { addedLines } from "@/lib/monitor/careers";
import { detectPriceMove, sparklinePath } from "@/lib/monitor/price";
import { newsKey } from "@/lib/monitor/signals";

const series = (closes: number[]) => closes.map((close, i) => ({ tradeDate: `2026-10-${String(i + 1).padStart(2, "0")}`, close }));

describe("price moves", () => {
  it("ignores ordinary days", () => {
    expect(detectPriceMove(series([10, 10.1, 10.2, 10.15]), "Acme")).toBeNull();
  });

  it("flags a 5% day as medium and 10% as high, with direction", () => {
    expect(detectPriceMove(series([10, 10.6]), "Acme")).toMatchObject({ importance: "medium", dayChangePct: 6, title: "Acme shares up 6% on 2026-10-02" });
    expect(detectPriceMove(series([10, 8.8]), "Acme")).toMatchObject({ importance: "high", dayChangePct: -12, title: expect.stringContaining("down 12%") });
  });

  it("flags a slow slide against the 30-day average", () => {
    const slide = series([...Array(20).fill(10), 9.6, 9.3, 9.0, 8.9, 8.8]);
    expect(detectPriceMove(slide, "Acme")).toMatchObject({ importance: "medium" });
  });

  it("draws a sparkline inside its box", () => {
    const d = sparklinePath([1, 3, 2], 100, 20);
    expect(d).toBe("M2.0,18.0 L50.0,2.0 L98.0,10.0");
    expect(sparklinePath([1], 100, 20)).toBe("");
  });
});

describe("careers changes", () => {
  it("returns lines that are new on the page", () => {
    expect(addedLines("Jobs\nData Analyst\nDriver", "Jobs\nData Analyst\nCloud Security Engineer\nDriver\n  Platform   Lead  ")).toEqual(["Cloud Security Engineer", "Platform Lead"]);
  });
});

describe("advisory matching", () => {
  const stack = [
    { vendor: "Citrix", product: "NetScaler ADC" },
    { vendor: "AWS", product: "CloudFront" },
    { vendor: "Google", product: "Tag Manager" },
    { vendor: "Microsoft", product: "Entra ID (sign-in)" },
  ];

  it("uses specific product names and vendor + product, never generic words", () => {
    const terms = stackTerms(stack);
    expect(terms).toContain("NetScaler ADC");
    expect(terms).toContain("Entra ID");
    expect(terms).not.toContain("Tag Manager");
  });

  it("matches advisories that name a product in the stack", () => {
    expect(advisoryMatches({ title: "Critical flaw in NetScaler ADC and Gateway", text: "Patch now" }, stack)).toEqual(["NetScaler ADC"]);
    expect(advisoryMatches({ title: "Fortinet FortiOS vulnerability", text: "" }, stack)).toEqual([]);
  });
});

describe("news dedupe", () => {
  it("keys syndicated headlines together", () => {
    expect(newsKey("Bellbird names new CISO!")).toBe(newsKey("bellbird names new CISO"));
  });
});
