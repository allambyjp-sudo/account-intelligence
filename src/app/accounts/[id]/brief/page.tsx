import { and, desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import type { BriefSectionKind } from "@/lib/domain/enums";
import { formatDateTime, humanise, ORG_NAME } from "@/lib/format";
import { SECTION_ORDER } from "@/lib/research/run";
import { rerunResearch } from "../../../actions/accounts";
import { AutoRefresh } from "../../../auto-refresh";
import { Claim, citationNumbers, CitedText, SourceList, type ClaimLike } from "../../../cited";
import { Badge, Card, Empty } from "../../../components";

const UUID = /^[0-9a-f-]{36}$/i;
const TITLES: Record<BriefSectionKind, string> = {
  profile: "Company profile",
  stakeholders: "Stakeholders",
  tech_stack: "Tech stack hypothesis",
  challenges: "Challenges and opportunities",
  licensing_lens: "Licensing lens",
  services_fit: `${ORG_NAME} fit`,
};

type Ctx = { numbers: Map<string, number>; sources: Map<string, t.Source> };

export default async function BriefPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser(`/accounts/${id}/brief`);
  if (!UUID.test(id)) notFound();
  const db = getDb();
  const [account] = await db.select().from(t.accounts).where(and(eq(t.accounts.id, id), eq(t.accounts.ownerUserId, user.id))).limit(1);
  if (!account) notFound();

  const [rows, runs] = await Promise.all([
    db.select().from(t.briefSections).where(eq(t.briefSections.accountId, id)).orderBy(desc(t.briefSections.version)),
    db.select().from(t.researchRuns).where(eq(t.researchRuns.accountId, id)).orderBy(desc(t.researchRuns.createdAt)).limit(10),
  ]);
  const latest = new Map<BriefSectionKind, t.BriefSection>();
  for (const r of rows) if (!latest.has(r.section)) latest.set(r.section, r);
  const ids = [...new Set([...latest.values()].flatMap((s) => s.sourceIds))];
  const sources = new Map((ids.length ? await db.select().from(t.sources).where(inArray(t.sources.id, ids)) : []).map((s) => [s.id, s]));
  const active = runs.find((r) => r.status === "queued" || r.status === "running");

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      {active && <AutoRefresh seconds={4} />}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href={`/accounts/${id}`} className="text-sm text-brand-700 hover:underline">
            ← {account.name}
          </Link>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Account brief</h1>
          <p className="text-sm text-slate-600">Every statement links to its source. Anything without one is marked Unconfirmed.</p>
        </div>
        <form action={rerunResearch}>
          <input type="hidden" name="accountId" value={id} />
          <button disabled={Boolean(active)} className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300">
            {active ? `Research ${active.status}${active.stage ? `: ${humanise(active.stage)}` : ""}…` : "Re-run research"}
          </button>
        </form>
      </div>

      {SECTION_ORDER.map((section) => {
        const row = latest.get(section);
        if (!row) {
          return (
            <Card key={section} title={TITLES[section]}>
              <Empty>Not researched yet.</Empty>
            </Card>
          );
        }
        const ctx: Ctx = { numbers: citationNumbers(row.sourceIds), sources };
        return (
          <Card
            key={section}
            title={TITLES[section]}
            action={
              <span className="text-[11px] text-slate-400" title={`${row.promptId} v${row.promptVersion} · ${row.model}`}>
                v{row.version} · {formatDateTime(row.generatedAt)}
              </span>
            }
          >
            <p className="text-sm leading-relaxed text-slate-800">
              <CitedText text={row.summaryMd} {...ctx} />
            </p>
            <div className="mt-3 text-sm text-slate-700">
              <SectionDetail section={section} content={row.content} ctx={ctx} />
            </div>
            <SourceList sourceIds={row.sourceIds} sources={sources} />
          </Card>
        );
      })}

      <Card title="Research runs">
        {runs.length === 0 ? (
          <Empty>No research has run yet.</Empty>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr>
                <th className="py-1 font-medium">Started</th>
                <th className="font-medium">Status</th>
                <th className="font-medium">Sources</th>
                <th className="font-medium">Tokens in / out</th>
                <th className="font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {runs.map((r) => {
                const stats = r.stats as { gather?: { sources?: Record<string, number>; skipped?: Record<string, string>; failed?: Record<string, string> }; sections?: Record<string, string> };
                const count = Object.values(stats.gather?.sources ?? {}).reduce((a, b) => a + b, 0);
                const problems = [...Object.entries(stats.gather?.failed ?? {}).map(([k, v]) => `${k}: ${v}`), ...Object.entries(stats.sections ?? {}).filter(([, v]) => v !== "ok").map(([k, v]) => `${k}: ${v}`)];
                return (
                  <tr key={r.id} className="align-top">
                    <td className="py-1.5 pr-2">{formatDateTime(r.startedAt ?? r.createdAt)}</td>
                    <td className="pr-2">
                      <Badge className={r.status === "succeeded" ? "bg-emerald-50 text-emerald-800 ring-emerald-600/20" : r.status === "failed" ? "bg-red-50 text-red-800 ring-red-600/20" : "bg-slate-100 text-slate-700 ring-slate-500/20"}>
                        {humanise(r.status)}
                      </Badge>
                    </td>
                    <td className="pr-2 tabular">{count || "—"}</td>
                    <td className="pr-2 tabular">{r.usage.inputTokens ? `${r.usage.inputTokens.toLocaleString("en-AU")} / ${(r.usage.outputTokens ?? 0).toLocaleString("en-AU")}` : "—"}</td>
                    <td className="text-slate-500">
                      {r.error ?? null}
                      {problems.length > 0 && <div>{problems.slice(0, 4).join("; ")}</div>}
                      {Object.keys(stats.gather?.skipped ?? {}).length > 0 && <div>Skipped: {Object.keys(stats.gather!.skipped!).join(", ")}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Claims({ items, ctx, empty }: { items: ClaimLike[]; ctx: Ctx; empty?: string }) {
  if (!items.length) return empty ? <p className="text-slate-500">{empty}</p> : null;
  return (
    <ul className="list-disc space-y-1 pl-5">
      {items.map((c, i) => (
        <li key={i}>
          <Claim claim={c} {...ctx} />
        </li>
      ))}
    </ul>
  );
}

function SectionDetail({ section, content, ctx }: { section: BriefSectionKind; content: unknown; ctx: Ctx }) {
  const c = content as Record<string, any>;
  switch (section) {
    case "profile":
      return (
        <div className="space-y-2">
          {c.financials?.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase text-slate-500">Financials</h4>
              <Claims items={c.financials} ctx={ctx} />
            </div>
          )}
          {c.history?.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase text-slate-500">Timeline</h4>
              <ul className="space-y-1">
                {c.history.map((h: { when: string; claim: ClaimLike }, i: number) => (
                  <li key={i}>
                    <span className="tabular text-slate-500">{h.when}</span> <Claim claim={h.claim} {...ctx} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {c.subsidiaries?.length > 0 && <p className="text-xs text-slate-600">Subsidiaries: {c.subsidiaries.map((s: { name: string }) => s.name).join(", ")}</p>}
        </div>
      );
    case "challenges":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <h4 className="text-xs font-semibold uppercase text-slate-500">Challenges</h4>
            <Claims items={c.challenges ?? []} ctx={ctx} empty="None found." />
          </div>
          <div>
            <h4 className="text-xs font-semibold uppercase text-slate-500">Opportunities</h4>
            <Claims items={c.opportunities ?? []} ctx={ctx} empty="None found." />
          </div>
        </div>
      );
    case "licensing_lens":
      return (
        <div className="space-y-2">
          <p>
            <span className="font-medium">Microsoft agreement renewal: </span>
            {c.eaRenewal?.estimate ?? "No estimate"} <span className="text-slate-500">(estimate)</span>
          </p>
          <p className="text-slate-600">
            <Claim claim={c.eaRenewal?.reasoning} {...ctx} />
          </p>
          {c.vendorFootprint?.length > 0 && (
            <ul className="space-y-1">
              {c.vendorFootprint.map((v: { vendor: string; products: string[]; claim: ClaimLike }, i: number) => (
                <li key={i}>
                  <span className="font-medium">{v.vendor}</span>: {v.products.join(", ")} <span className="text-slate-500">·</span> <Claim claim={v.claim} {...ctx} />
                </li>
              ))}
            </ul>
          )}
          {c.openings?.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase text-slate-500">Openings</h4>
              <Claims items={c.openings} ctx={ctx} />
            </div>
          )}
        </div>
      );
    case "services_fit":
      return (
        <ul className="space-y-2">
          {(c.matches ?? []).map((m: { painPoint: ClaimLike; catalogueSlugs: string[]; rationale: string }, i: number) => (
            <li key={i}>
              <Claim claim={m.painPoint} {...ctx} />
              <div className="mt-0.5 flex flex-wrap gap-1">
                {m.catalogueSlugs.map((s) => (
                  <Badge key={s} className="bg-brand-50 text-brand-700 ring-brand-600/20">
                    {s}
                  </Badge>
                ))}
              </div>
              <p className="text-xs text-slate-500">{m.rationale}</p>
            </li>
          ))}
        </ul>
      );
    case "stakeholders":
    case "tech_stack":
      return <p className="text-xs text-slate-500">Details are on the account page, where they stay up to date between research runs.</p>;
  }
}
