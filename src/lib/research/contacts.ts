import type { ContactConfidence } from "@/lib/domain/enums";

/**
 * Work email patterns. Never guessed blind, never probed against a mail server:
 *  - published: the exact address appears in a cited source;
 *  - verified_pattern: the domain's pattern is confirmed by two or more published addresses;
 *  - inferred: the pattern rests on a single published address.
 * With no published address on the domain, we don't produce an address at all.
 */
export const PATTERNS = [
  "{first}.{last}",
  "{first}{last}",
  "{f}{last}",
  "{f}.{last}",
  "{first}_{last}",
  "{first}-{last}",
  "{first}",
  "{last}.{first}",
  "{first}{l}",
] as const;
export type Pattern = (typeof PATTERNS)[number];

export const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "yahoo.com.au",
  "bigpond.com",
  "bigpond.net.au",
  "icloud.com",
  "me.com",
  "xtra.co.nz",
  "protonmail.com",
  "proton.me",
]);

export const isPersonalDomain = (domain: string) => PERSONAL_DOMAINS.has(domain.toLowerCase());

const clean = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z-]/g, "");

/** First and last name parts for patterns. Middle names and honorifics are ignored. */
export function nameParts(fullName: string): { first: string; last: string } | null {
  const words = fullName
    .replace(/\b(dr|mr|mrs|ms|prof|professor|sir|dame)\.?\s+/gi, "")
    .split(/\s+/)
    .map(clean)
    .filter(Boolean);
  if (words.length < 2) return null;
  return { first: words[0]!, last: words[words.length - 1]! };
}

export function applyPattern(p: Pattern, n: { first: string; last: string }): string {
  return p
    .replace("{first}", n.first)
    .replace("{last}", n.last)
    .replace("{f}", n.first[0]!)
    .replace("{l}", n.last[0]!);
}

/** Which patterns explain a known address for a known person. */
export function patternsFor(localPart: string, fullName: string): Pattern[] {
  const n = nameParts(fullName);
  if (!n) return [];
  return PATTERNS.filter((p) => applyPattern(p, n) === localPart.toLowerCase());
}

export interface KnownAddress {
  fullName: string;
  email: string;
}

export interface InferredAddress {
  email: string;
  confidence: Exclude<ContactConfidence, "published">;
  pattern: string;
}

/**
 * Given published addresses at a domain, propose an address for someone else at that domain.
 * Returns null when the evidence doesn't support a guess.
 */
export function inferAddress(fullName: string, domain: string, known: KnownAddress[]): InferredAddress | null {
  const d = domain.toLowerCase();
  if (isPersonalDomain(d)) return null;
  const n = nameParts(fullName);
  if (!n) return null;

  const support = new Map<Pattern, Set<string>>();
  for (const k of known) {
    const [local, host] = k.email.toLowerCase().split("@");
    if (!local || host !== d) continue;
    for (const p of patternsFor(local, k.fullName)) {
      if (!support.has(p)) support.set(p, new Set());
      support.get(p)!.add(k.email.toLowerCase());
    }
  }
  if (!support.size) return null;
  // Prefer the best-supported pattern; ties go to the more specific one (earlier in PATTERNS).
  const [best, examples] = [...support.entries()].sort((a, b) => b[1].size - a[1].size || PATTERNS.indexOf(a[0]) - PATTERNS.indexOf(b[0]))[0]!;
  return {
    email: `${applyPattern(best, n)}@${d}`,
    confidence: examples.size >= 2 ? "verified_pattern" : "inferred",
    pattern: `${best}@${d}`,
  };
}
