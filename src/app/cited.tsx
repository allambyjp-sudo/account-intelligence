import type { Source } from "@/lib/db/schema";
import type { Confidence, Verification } from "@/lib/domain/enums";
import { formatDate } from "@/lib/format";
import { ConfidenceBadge, VerificationBadge } from "./components";

const TOKEN = /\[\[src:([0-9a-f-]{36})\]\]/g;

/** Numbers citations in the order a section lists its sources. */
export function citationNumbers(sourceIds: string[]): Map<string, number> {
  return new Map(sourceIds.map((id, i) => [id, i + 1]));
}

function Cite({ n, source }: { n: number | undefined; source: Source | undefined }) {
  if (!n || !source) return null;
  return (
    <a href={source.url} target="_blank" rel="noopener noreferrer" title={source.title ?? source.url} className="ml-0.5 align-super text-[10px] font-medium text-brand-700 hover:underline">
      [{n}]
    </a>
  );
}

/** Model prose with [[src:id]] tokens rendered as numbered citation links. */
export function CitedText({ text, numbers, sources }: { text: string; numbers: Map<string, number>; sources: Map<string, Source> }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    parts.push(text.slice(last, m.index));
    parts.push(<Cite key={`${m.index}`} n={numbers.get(m[1]!)} source={sources.get(m[1]!)} />);
    last = m.index! + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

export interface ClaimLike {
  text: string;
  sourceIds: string[];
  confidence: Confidence;
  verification: Verification;
}

export function Claim({ claim, numbers, sources }: { claim: ClaimLike | null | undefined; numbers: Map<string, number>; sources: Map<string, Source> }) {
  if (!claim) return null;
  return (
    <span>
      {claim.text}
      {claim.sourceIds.map((id) => (
        <Cite key={id} n={numbers.get(id)} source={sources.get(id)} />
      ))}{" "}
      <VerificationBadge verification={claim.verification} />
      {claim.verification === "verified" && claim.confidence !== "high" && (
        <>
          {" "}
          <ConfidenceBadge confidence={claim.confidence} />
        </>
      )}
    </span>
  );
}

export function SourceList({ sourceIds, sources }: { sourceIds: string[]; sources: Map<string, Source> }) {
  const list = sourceIds.map((id) => sources.get(id)).filter((s): s is Source => Boolean(s));
  if (!list.length) return null;
  return (
    <ol className="mt-3 space-y-0.5 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
      {list.map((s, i) => (
        <li key={s.id}>
          [{i + 1}]{" "}
          <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline decoration-slate-300 underline-offset-2 hover:text-brand-700">
            {s.title ?? s.url}
          </a>
          {s.publisher && <> · {s.publisher}</>} · retrieved {formatDate(s.retrievedAt)}
        </li>
      ))}
    </ol>
  );
}
