import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PERSONAL_DOMAINS } from "@/lib/research/contacts";
import { FOOTPRINT_RULES } from "@/lib/sources/footprint";
import { sourceHosts } from "@/lib/sources/registry";

/**
 * Guard for the brief's rule: commit no real customer data. Seed data, fixtures and prompts may
 * only use reserved domains (RFC 2606 / RFC 6761). Public source hosts that adapters call are
 * listed in src/lib/http/policy.ts, which this test deliberately doesn't scan.
 */
const SCANNED = ["src/lib/demo", "tests", "prompts", "data"];
const RESERVED = /(^|\.)(example|test|invalid|localhost)$|(^|\.)example\.(com|net|org)$/i;
// Hosts allowed because they name the services and public sources being integrated, not customers.
const INFRASTRUCTURE = new Set([
  "login.microsoftonline.com",
  "graph.microsoft.com",
  "api.anthropic.com",
  "www.nzbn.govt.nz",
  "www.nzx.com",
  "gmail.googleapis.com",
  "oauth2.googleapis.com",
  "accounts.google.com",
  "www.w3.org",
  ...sourceHosts(),
]);
// Vendor infrastructure the tech footprint detector recognises (CDNs, SaaS script hosts).
const isVendorMarker = (host: string) => FOOTPRINT_RULES.some((r) => r.pattern.test(host) || r.pattern.test(`https://${host}/gtag/js`));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : /\.(ts|json|md|csv)$/.test(name) ? [full] : [];
  });
}

describe("no real data in the repository", () => {
  const all = SCANNED.flatMap((d) => files(path.join(process.cwd(), d))).filter((f) => !f.endsWith("no-real-data.test.ts"));

  it("uses only reserved domains in URLs and email addresses", () => {
    const offenders: string[] = [];
    for (const file of all) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
        const host = m[1]!.toLowerCase();
        if (!RESERVED.test(host) && !INFRASTRUCTURE.has(host) && !isVendorMarker(host)) offenders.push(`${path.relative(process.cwd(), file)}: ${host}`);
      }
      for (const m of text.matchAll(/\b[a-z0-9._%+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi)) {
        const host = m[1]!.toLowerCase();
        // Personal mail providers appear only in tests proving such addresses are rejected.
        if (!RESERVED.test(host) && !PERSONAL_DOMAINS.has(host) && !/^(anthropic-ai|azure|types|tailwindcss)\//.test(m[0])) offenders.push(`${path.relative(process.cwd(), file)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
