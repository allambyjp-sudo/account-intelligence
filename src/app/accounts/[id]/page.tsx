import { notFound } from "next/navigation";
import { loadAccountPage, type AccountPage, type TimelineItem } from "@/lib/accounts/queries";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db/client";
import type { BriefSectionKind } from "@/lib/domain/enums";
import { formatDate, formatDateTime, humanise, ORG_NAME, timeAgo } from "@/lib/format";
import {
  Badge,
  Card,
  ConfidenceBadge,
  ContactConfidenceBadge,
  Empty,
  FictionalBadge,
  ImportanceBadge,
  SourceLink,
  VerificationBadge,
} from "../../components";
import { AutoRefresh } from "../../auto-refresh";
import { citationNumbers, CitedText } from "../../cited";
import Link from "next/link";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SECTION_TITLES: Record<BriefSectionKind, string> = {
  profile: "Company profile",
  stakeholders: "Stakeholders",
  tech_stack: "Tech stack",
  challenges: "Challenges and opportunities",
  licensing_lens: "Licensing lens",
  services_fit: `${ORG_NAME} fit`,
};

export default async function AccountPageView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser(`/accounts/${id}`);
  if (!UUID.test(id)) notFound();
  const page = await loadAccountPage(getDb(), user.id, id);
  if (!page) notFound();

  const running = page.latestRun && (page.latestRun.status === "queued" || page.latestRun.status === "running");
  return (
    <div className="space-y-4">
      {running && <AutoRefresh seconds={5} />}
      <Header page={page} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <BriefSummary page={page} />
          <Stakeholders page={page} />
          <TechStack page={page} />
        </div>
        <div className="space-y-4">
          <Timeline items={page.timeline} />
        </div>
        <div className="space-y-4">
          <Advisor page={page} />
          <Alerts page={page} />
          <Card title="Meeting prep">
            <button disabled className="w-full cursor-not-allowed rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-500" title="Phase 5">
              Prepare for a meeting
            </button>
            <p className="mt-2 text-xs text-slate-500">One-click one-pager with attendee profiles and openers arrives in Phase 5.</p>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Header({ page }: { page: AccountPage }) {
  const { account, primaryEntity: e } = page;
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">{account.name}</h1>
          {account.isFictional && <FictionalBadge />}
          {account.isKeyAccount && <Badge className="bg-brand-50 text-brand-700 ring-brand-600/20">Key account</Badge>}
          {account.emailExcluded && (
            <Badge className="bg-slate-100 text-slate-600 ring-slate-500/20" title={account.emailExcludedReason ?? undefined}>
              Email excluded
            </Badge>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 text-sm text-slate-600">
          {e?.legalName && e.legalName !== account.name && <span>{e.legalName}</span>}
          {e?.industry && <span>{e.industry}</span>}
          {e?.headcount != null && <span>~{e.headcount.toLocaleString("en-AU")} staff</span>}
          {e?.abn && <span className="tabular">ABN {e.abn.replace(/(\d{2})(\d{3})(\d{3})(\d{3})/, "$1 $2 $3 $4")}</span>}
          {e?.nzbn && <span className="tabular">NZBN {e.nzbn}</span>}
          {e?.domain && <span>{e.domain}</span>}
        </div>
      </div>
      <div className="text-right text-xs text-slate-500">
        <div className="text-sm font-medium text-slate-800">{e?.ticker ? `${e.exchange}:${e.ticker}` : "Unlisted"}</div>
        <div>{e?.ticker ? "Share price arrives in Phase 3" : "No share price"}</div>
        <Link href={`/accounts/${account.id}/settings`} className="text-brand-700 hover:underline">
          Settings
        </Link>
        <div className="mt-1">Last researched {account.lastResearchedAt ? formatDateTime(account.lastResearchedAt) : "never"}</div>
        <div>Worker last seen {timeAgo(page.workerLastSeen)}</div>
      </div>
    </div>
  );
}

function BriefSummary({ page }: { page: AccountPage }) {
  const sections = (Object.keys(SECTION_TITLES) as BriefSectionKind[]).filter((s) => page.brief[s] && s !== "stakeholders" && s !== "tech_stack");
  const run = page.latestRun;
  const running = run && (run.status === "queued" || run.status === "running");
  return (
    <Card
      title="Brief"
      action={
        <Link href={`/accounts/${page.account.id}/brief`} className="text-xs text-brand-700 hover:underline">
          Full brief →
        </Link>
      }
    >
      {running && <p className="mb-2 rounded-md bg-sky-50 px-2 py-1 text-xs text-sky-800">Research {run.status}{run.stage ? `: ${humanise(run.stage)}` : ""}…</p>}
      {sections.length === 0 ? (
        <Empty>{running ? "The brief appears here when research finishes." : "No brief yet. Open the full brief to run research."}</Empty>
      ) : (
        <div className="space-y-4">
          {sections.map((s) => {
            const b = page.brief[s]!;
            const numbers = citationNumbers(b.sourceIds);
            return (
              <div key={s}>
                <h3 className="text-sm font-semibold text-slate-800">{SECTION_TITLES[s]}</h3>
                <p className="mt-1 text-sm text-slate-700">
                  <CitedText text={b.summaryMd} numbers={numbers} sources={page.sources} />
                </p>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function Stakeholders({ page }: { page: AccountPage }) {
  return (
    <Card title="Stakeholders">
      {page.stakeholders.length === 0 ? (
        <Empty>No stakeholders yet.</Empty>
      ) : (
        <ul className="divide-y divide-slate-100">
          {page.stakeholders.map((s) => (
            <li key={s.id} className="py-2.5 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium text-slate-900">{s.fullName}</span>
                {s.relationship !== "unknown" && <Badge className="bg-brand-50 text-brand-700 ring-brand-600/20">{humanise(s.relationship)}</Badge>}
                {s.employmentStatus === "departed" && <Badge className="bg-red-50 text-red-800 ring-red-600/20">Departed</Badge>}
                <VerificationBadge verification={s.verification} />
              </div>
              <div className="text-xs text-slate-600">
                {s.title}
                {s.tenureStartedOn && <> · since {formatDate(s.tenureStartedOn)}</>}
              </div>
              <SourceLink source={s.sourceId ? page.sources.get(s.sourceId) : undefined} retrievedAt={s.retrievedAt} />
              {s.contacts.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {s.contacts.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-1.5 text-xs text-slate-700">
                      <span className="tabular">{c.value}</span>
                      <ContactConfidenceBadge confidence={c.confidence} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function TechStack({ page }: { page: AccountPage }) {
  return (
    <Card title="Tech stack hypothesis">
      {page.techStack.length === 0 ? (
        <Empty>No tech stack evidence yet.</Empty>
      ) : (
        <ul className="space-y-2">
          {page.techStack.map((t) => (
            <li key={t.id}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm text-slate-900">{t.product.startsWith(t.vendor) ? t.product : `${t.vendor} ${t.product}`}</span>
                <ConfidenceBadge confidence={t.confidence} />
                <VerificationBadge verification={t.verification} />
              </div>
              <div className="text-xs text-slate-500">
                {humanise(t.category)} · from {humanise(t.evidenceKind).toLowerCase()}
                {t.evidenceExcerpt && <> · “{t.evidenceExcerpt}”</>}
              </div>
              <SourceLink source={t.sourceId ? page.sources.get(t.sourceId) : undefined} retrievedAt={t.retrievedAt} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Timeline({ items }: { items: TimelineItem[] }) {
  return (
    <Card title="Live timeline">
      {items.length === 0 ? (
        <Empty>News, announcements, tenders, hiring and email land here. Live polling starts in Phase 3.</Empty>
      ) : (
        <ol className="relative space-y-4 border-l border-slate-200 pl-4">
          {items.map((item) => (
            <li key={item.kind === "signal" ? item.signal.id : item.thread.id} className="relative">
              <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-slate-400" />
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                <span>{formatDate(item.at)}</span>
                {item.kind === "signal" ? (
                  <>
                    <Badge className="bg-slate-100 text-slate-700 ring-slate-500/20">{humanise(item.signal.channel)}</Badge>
                    {item.signal.signalType !== "unclassified" && <span>{humanise(item.signal.signalType)}</span>}
                    {item.signal.importance && <ImportanceBadge importance={item.signal.importance} />}
                  </>
                ) : (
                  <>
                    <Badge className="bg-sky-50 text-sky-800 ring-sky-600/20">Email</Badge>
                    {item.thread.classification && <span>{humanise(item.thread.classification)}</span>}
                  </>
                )}
              </div>
              {item.kind === "signal" ? (
                <>
                  <div className="mt-0.5 text-sm font-medium text-slate-900">{item.signal.title}</div>
                  {item.signal.summary && <p className="text-sm text-slate-600">{item.signal.summary}</p>}
                  <SourceLink source={item.source} />
                </>
              ) : (
                <>
                  <div className="mt-0.5 text-sm font-medium text-slate-900">{item.thread.subject}</div>
                  {item.latestSummary && <p className="text-sm text-slate-600">{item.latestSummary.summary}</p>}
                </>
              )}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function Advisor({ page }: { page: AccountPage }) {
  return (
    <Card title="Sales advisor">
      {page.recommendations.length === 0 ? (
        <Empty>Next best actions, talking points and risk flags arrive in Phase 4.</Empty>
      ) : (
        <ul className="space-y-3">
          {page.recommendations.map((r) => (
            <li key={r.id}>
              <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{humanise(r.kind)}</div>
              <div className="text-sm font-medium text-slate-900">{r.title}</div>
              <p className="text-sm text-slate-600">{r.body}</p>
              <div className="mt-0.5 flex flex-wrap gap-x-3">
                {r.evidence.map((e, i) =>
                  e.kind === "source" ? (
                    <SourceLink key={i} source={page.sources.get(e.sourceId)} />
                  ) : (
                    <span key={i} className="text-[11px] text-slate-500">
                      Evidence: {e.kind}
                    </span>
                  ),
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Alerts({ page }: { page: AccountPage }) {
  return (
    <Card title="Alerts">
      {page.alerts.length === 0 ? (
        <Empty>No open alerts.</Empty>
      ) : (
        <ul className="space-y-2">
          {page.alerts.map((a) => (
            <li key={a.id} className="flex items-start gap-2">
              <ImportanceBadge importance={a.importance} />
              <div>
                <div className="text-sm text-slate-900">{a.title}</div>
                {a.body && <p className="text-xs text-slate-600">{a.body}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
