import { describe, expect, it } from "vitest";
import { loadCatalogue, parseCatalogue } from "@/lib/catalogue/catalogue";

describe("services catalogue", () => {
  it("parses the maintained file", () => {
    expect(loadCatalogue().length).toBeGreaterThan(0);
  });

  it("rejects duplicate slugs and unknown fields", () => {
    const item = { slug: "a", kind: "service", name: "A", summary: "s" };
    expect(() => parseCatalogue({ items: [item, item] })).toThrow(/duplicate slug/);
    expect(() => parseCatalogue({ items: [{ ...item, price: 10 }] })).toThrow(/invalid/);
  });
});
