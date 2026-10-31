import type { Confidence, Verification } from "@/lib/domain/enums";
import type { SourcePack } from "./pack";

export interface CitationStats {
  /** Refs the model used that weren't in the pack. Dropped, and counted so prompt problems show up. */
  invalidRefs: number;
  unconfirmedClaims: number;
  droppedQuotes: number;
  droppedContacts: number;
}

export const emptyStats = (): CitationStats => ({ invalidRefs: 0, unconfirmedClaims: 0, droppedQuotes: 0, droppedContacts: 0 });

/** Maps "S3"-style refs to source ids, dropping refs the run never handed out. */
export function resolveRefs(refs: string[], pack: SourcePack, stats: CitationStats): string[] {
  const ids: string[] = [];
  for (const raw of refs) {
    const ref = raw.trim().replace(/^\[|\]$/g, "").toUpperCase();
    const source = pack.byRef.get(ref);
    if (!source) {
      stats.invalidRefs++;
      continue;
    }
    if (!ids.includes(source.id)) ids.push(source.id);
  }
  return ids;
}

export interface ResolvedClaim {
  text: string;
  sourceIds: string[];
  confidence: Confidence;
  verification: Verification;
}

/** A claim is verified only when at least one valid source backs it. Otherwise it's labelled Unconfirmed. */
export function resolveClaim(c: { text: string; sources: string[]; confidence: Confidence }, pack: SourcePack, stats: CitationStats): ResolvedClaim {
  const sourceIds = resolveRefs(c.sources, pack, stats);
  if (!sourceIds.length) stats.unconfirmedClaims++;
  return { text: c.text, sourceIds, confidence: c.confidence, verification: sourceIds.length ? "verified" : "unconfirmed" };
}

const MARKER = /\[(S\d+(?:\s*[,;]\s*S\d+)*)\]/gi;

/** Turns "[S3]" or "[S3, S5]" in model prose into stored [[src:<uuid>]] tokens; unknown refs vanish. */
export function tokeniseSummary(summary: string, pack: SourcePack, stats: CitationStats): { text: string; sourceIds: string[] } {
  const used: string[] = [];
  const text = summary
    .replace(MARKER, (_, inner: string) => {
      const ids = resolveRefs(inner.split(/[,;]/), pack, stats);
      for (const id of ids) if (!used.includes(id)) used.push(id);
      return ids.map((id) => `[[src:${id}]]`).join("");
    })
    .replace(/[ \t]+(\[\[src:)/g, "$1")
    .replace(/[ \t]+([.,;:])/g, "$1")
    .trim();
  return { text, sourceIds: used };
}

export const normaliseForMatch = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\p{L}\p{N}@.+'" ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Does the source's text actually contain this string? Used for quotes, emails and phone numbers. */
export function appearsIn(needle: string, sourceText: string | null | undefined): boolean {
  if (!sourceText) return false;
  const n = normaliseForMatch(needle);
  return n.length >= 3 && normaliseForMatch(sourceText).includes(n);
}

export const digitsOnly = (s: string) => s.replace(/\D/g, "");

/** Phone numbers match on digits, so "+61 3 9000 0000" finds "(03) 9000 0000" only if the digits agree. */
export function phoneAppearsIn(phone: string, sourceText: string | null | undefined): boolean {
  if (!sourceText) return false;
  const d = digitsOnly(phone);
  if (d.length < 8) return false;
  const local = d.replace(/^(61|64)/, "0");
  const hay = digitsOnly(sourceText);
  return hay.includes(d) || hay.includes(local);
}
