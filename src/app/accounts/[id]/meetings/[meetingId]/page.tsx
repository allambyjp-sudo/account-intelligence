import { and, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import { buildOnePager } from "@/lib/meetings/onepager";
import type { MeetingPrep } from "@/lib/meetings/prep";
import { regeneratePrep } from "../../../../actions/meetings";
import { AutoRefresh } from "../../../../auto-refresh";
import { Card } from "../../../../components";

const Cites = ({ cites }: { cites: number[] }) =>
  cites.length ? (
    <sup className="ml-0.5 text-[10px] font-medium text-brand-700">
      {cites.map((c, i) => (
        <a key={c} href={`#ev-${c}`} className="hover:underline">
          {i ? "," : ""}
          {c}
        </a>
      ))}
    </sup>
  ) : null;

export default async function MeetingPage({ params }: { params: Promise<{ id: string; meetingId: string }> }) {
  const { id, meetingId } = await params;
  const user = await requireUser(`/accounts/${id}/meetings/${meetingId}`);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(meetingId)) notFound();
  const db = getDb();
  const [row] = await db
    .select({ m: t.meetings, a: t.accounts })
    .from(t.meetings)
    .innerJoin(t.accounts, eq(t.meetings.accountId, t.accounts.id))
    .where(and(eq(t.meetings.id, meetingId), eq(t.meetings.accountId, id), eq(t.accounts.ownerUserId, user.id)))
    .limit(1);
  if (!row) notFound();
  const { m, a } = row;
  const people = m.attendeeStakeholderIds.length ? await db.select().from(t.stakeholders).where(inArray(t.stakeholders.id, m.attendeeStakeholderIds)) : [];

  const back = (
    <Link href={`/accounts/${id}`} className="text-sm text-brand-700 hover:underline">
      ← {a.name}
    </Link>
  );
  if (!m.prep || !m.prepGeneratedAt) {
    return (
      <div className="mx-auto max-w-2xl space-y-3">
        {!m.prepError && <AutoRefresh seconds={3} />}
        {back}
        <Card>
          {m.prepError ? (
            <>
              <p className="text-sm text-red-800">Meeting prep failed: {m.prepError}</p>
              <form action={regeneratePrep} className="mt-2">
                <input type="hidden" name="meetingId" value={m.id} />
                <button className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">Try again</button>
              </form>
            </>
          ) : (
            <p className="text-sm text-slate-700">Preparing your one-pager for “{m.title}”… This usually takes under a minute.</p>
          )}
        </Card>
      </div>
    );
  }

  const op = buildOnePager({ accountName: a.name, meetingTitle: m.title, scheduledFor: m.scheduledFor, attendees: [...people.map((p) => p.fullName), ...m.otherAttendees.map((o) => o.name)], prep: m.prep as MeetingPrep, generatedAt: m.prepGeneratedAt });
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          {back}
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">{op.title}</h1>
          <p className="text-sm text-slate-600">{op.subtitle}</p>
        </div>
        <div className="flex gap-2 text-sm">
          <a href={`/api/meetings/${m.id}/export?format=pdf`} className="rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700">
            PDF
          </a>
          <a href={`/api/meetings/${m.id}/export?format=docx`} className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-700 hover:bg-slate-50">
            Word
          </a>
          <form action={regeneratePrep}>
            <input type="hidden" name="meetingId" value={m.id} />
            <button className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-700 hover:bg-slate-50">Regenerate</button>
          </form>
        </div>
      </div>
      <Card>
        <div className="space-y-4">
          {op.sections.map((s) => (
            <section key={s.heading}>
              <h2 className="text-sm font-semibold text-brand-900">{s.heading}</h2>
              {s.paragraphs?.map((p, i) => (
                <p key={i} className="mt-1 text-sm text-slate-800">
                  {p.text}
                  <Cites cites={p.cites} />
                </p>
              ))}
              {s.items && (
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-800">
                  {s.items.map((it, i) => (
                    <li key={i}>
                      <span className={it.detail ? "font-medium" : ""}>{it.text}</span>
                      <Cites cites={it.cites} />
                      {it.detail && <div className="text-slate-600">{it.detail}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
          {op.sources.length > 0 && (
            <ol className="space-y-0.5 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
              {op.sources.map((s) => (
                <li key={s.n} id={`ev-${s.n}`}>
                  [{s.n}]{" "}
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline decoration-slate-300 underline-offset-2">
                      {s.label}
                    </a>
                  ) : (
                    s.label
                  )}{" "}
                  · {s.date}
                </li>
              ))}
            </ol>
          )}
          <p className="text-[11px] italic text-slate-400">{op.footer}</p>
        </div>
      </Card>
    </div>
  );
}
