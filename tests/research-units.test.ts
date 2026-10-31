import { describe, expect, it } from "vitest";
import type { Source } from "@/lib/db/schema";
import { appearsIn, emptyStats, phoneAppearsIn, resolveClaim, tokeniseSummary } from "@/lib/research/citations";
import { applyPattern, inferAddress, nameParts, patternsFor } from "@/lib/research/contacts";
import { buildPack } from "@/lib/research/pack";

const src = (id: string, type: Source["sourceType"], body: string, extra: Partial<Source> = {}): Source => ({
  id,
  url: `https://site.example/${id}`,
  title: id,
  publisher: null,
  adapter: "test",
  sourceType: type,
  publishedAt: null,
  retrievedAt: new Date("2026-10-30T00:00:00Z"),
  contentHash: null,
  excerpt: null,
  bodyText: body,
  ...extra,
});

describe("source pack", () => {
  it("puts registry and the company's own pages before news, numbers them, and respects the cap", () => {
    const pack = buildPack([src("n", "news", "news text"), src("r", "registry", "registry text"), src("w", "web", "x".repeat(20_000)), src("empty", "web", "")]);
    expect(pack.entries.map((e) => `${e.ref}:${e.source.id}`)).toEqual(["S1:r", "S2:w", "S3:n"]);
    expect(pack.entries[1]!.text).toMatch(/\[truncated\]$/);
    expect(pack.rendered).toContain('<source ref="S1" type="registry" url="https://site.example/r">');
  });
});

describe("citations", () => {
  const pack = buildPack([src("a", "web", "Alpha"), src("b", "news", "Beta")]);

  it("resolves refs to source ids and drops ones it never handed out", () => {
    const stats = emptyStats();
    expect(resolveClaim({ text: "x", sources: ["S1", "s2", "[S2]", "S9"], confidence: "high" }, pack, stats)).toMatchObject({ sourceIds: ["a", "b"], verification: "verified" });
    expect(stats.invalidRefs).toBe(1);
  });

  it("labels a claim without sources Unconfirmed", () => {
    const stats = emptyStats();
    expect(resolveClaim({ text: "x", sources: [], confidence: "high" }, pack, stats).verification).toBe("unconfirmed");
    expect(stats.unconfirmedClaims).toBe(1);
  });

  it("turns [S#] markers into stored tokens and removes unknown ones", () => {
    const stats = emptyStats();
    const out = tokeniseSummary("Alpha grew [S1, S2]. Gamma shrank [S7].", pack, stats);
    expect(out.text).toBe("Alpha grew[[src:a]][[src:b]]. Gamma shrank.");
    expect(out.sourceIds).toEqual(["a", "b"]);
    expect(stats.invalidRefs).toBe(1);
  });

  it("checks quotes and contact details against the source text", () => {
    expect(appearsIn("“Data has to be safe.”", 'She said "data has to be safe." Then left.')).toBe(true);
    expect(appearsIn("Data must be safe", "data has to be safe")).toBe(false);
    expect(phoneAppearsIn("+61 3 9000 1234", "Call (03) 9000 1234")).toBe(true);
    expect(phoneAppearsIn("+61 3 9000 9999", "Call (03) 9000 1234")).toBe(false);
    expect(phoneAppearsIn("123", "123")).toBe(false);
  });
});

describe("work email patterns", () => {
  it("reads first and last names, ignoring honorifics and middle names", () => {
    expect(nameParts("Dr Mere Aroha Tamihana")).toEqual({ first: "mere", last: "tamihana" });
    expect(nameParts("Cher")).toBeNull();
    expect(applyPattern("{f}{last}", { first: "sam", last: "okafor" })).toBe("sokafor");
    expect(patternsFor("priya.natarajan", "Priya Natarajan")).toEqual(["{first}.{last}"]);
  });

  const known = [
    { fullName: "Priya Natarajan", email: "priya.natarajan@bellbird.example" },
    { fullName: "Tom Whitlock", email: "tom.whitlock@bellbird.example" },
  ];

  it("calls a pattern verified only with two or more published examples", () => {
    expect(inferAddress("Sam Okafor", "bellbird.example", known)).toEqual({ email: "sam.okafor@bellbird.example", confidence: "verified_pattern", pattern: "{first}.{last}@bellbird.example" });
    expect(inferAddress("Sam Okafor", "bellbird.example", known.slice(0, 1))!.confidence).toBe("inferred");
  });

  it("never guesses without a published example on that domain, or on personal domains", () => {
    expect(inferAddress("Sam Okafor", "bellbird.example", [])).toBeNull();
    expect(inferAddress("Sam Okafor", "other.example", known)).toBeNull();
    expect(inferAddress("Sam Okafor", "gmail.com", [{ fullName: "A B", email: "a.b@gmail.com" }])).toBeNull();
  });
});
