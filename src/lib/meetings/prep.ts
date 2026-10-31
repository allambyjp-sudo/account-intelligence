import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import type { EmbeddingProvider, LLMProvider } from "@/lib/llm/types";
import { searchMemory } from "@/lib/memory/memory";
import { getPrompt, renderPrompt } from "@/lib/prompts/loader";

const DAY = 86_400_000;
const refs = z.array(z.string()).describe('Evidence labels like "E3". Empty only where the item rests on general knowledge.');

export const prepOutput = z.object({
  purpose: z.string().describe("One line: what this meeting is for and what a good outcome looks like."),
  situation: z.string().describe("Three or four sentences: where the account stands today."),
  attendees: z.array(
    z.object({
      name: z.string(),
      role: z.string(),
      publicPriorities: z.string().describe("What they have said publicly or what their role is focused on."),
      historyWithUs: z.string().describe('What we know from notes and email. "No history on record" if none.'),
      evidence: refs,
    }),
  ),
  openingAngles: z.array(z.object({ angle: z.string(), why: z.string(), evidence: refs })).describe("Exactly three."),
  objections: z.array(z.object({ objection: z.string(), response: z.string(), evidence: refs })),
  changesSinceLastContact: z.array(z.object({ what: z.string(), evidence: refs })),
  openActions: z.array(z.object({ action: z.string(), owner: z.enum(["us", "them"]), due: z.string().nullable(), evidence: refs })),
});

/** Evidence as stored on the prep: the reference plus a frozen label, so exports never need lookups. */
export interface PrepEvidence {
  ref: t.EvidenceRef;
  label: string;
  url?: string;
  at: string;
}

type WithEvidence<T> = Omit<T, "evidence"> & { evidence: number[] };
export interface MeetingPrep {
  purpose: string;
  situation: string;
  attendees: Array<WithEvidence<z.infer<typeof prepOutput>["attendees"][number]>>;
  openingAngles: Array<WithEvidence<z.infer<typeof prepOutput>["openingAngles"][number]>>;
  objections: Array<WithEvidence<z.infer<typeof prepOutput>["objections"][number]>>;
  changesSinceLastContact: Array<WithEvidence<z.infer<typeof prepOutput>["changesSinceLastContact"][number]>>;
  openActions: Array<WithEvidence<z.infer<typeof prepOutput>["openActions"][number]>>;
  /** Numbered 1..n; items cite by number. */
  evidence: PrepEvidence[];
  lastContactAt: string | null;
}

/**
 * One-click meeting prep (brief, section 4.7): a one-page brief, attendee profiles, three opening
 * angles, likely objections, what's changed since the last contact and open actions, all tied to
 * evidence.
 */
export async function generateMeetingPrep(db: Db, llm: LLMProvider, embedder: EmbeddingProvider | null, meetingId: string, now = new Date()): Promise<MeetingPrep> {
  const [meeting] = await db.select().from(t.meetings).where(eq(t.meetings.id, meetingId)).limit(1);
  if (!meeting) throw new Error(`No meeting ${meetingId}`);
  const [account] = await db.select().from(t.accounts).where(eq(t.accounts.id, meeting.accountId)).limit(1);
  if (!account) throw new Error("Account no longer exists");

  const lastContact = account.lastContactAt;
  const since = lastContact ?? new Date(now.getTime() - 30 * DAY);
  const attendees = meeting.attendeeStakeholderIds.length ? await db.select().from(t.stakeholders).where(inArray(t.stakeholders.id, meeting.attendeeStakeholderIds)) : [];

  const [briefRows, changes, openSteps, threads, recs] = await Promise.all([
    db.select().from(t.briefSections).where(eq(t.briefSections.accountId, account.id)).orderBy(desc(t.briefSections.version)),
    db
      .select({ s: t.signals, src: t.sources })
      .from(t.signals)
      .innerJoin(t.sources, eq(t.signals.sourceId, t.sources.id))
      .where(and(eq(t.signals.accountId, account.id), eq(t.signals.relevant, true), gt(t.signals.occurredAt, since)))
      .orderBy(desc(t.signals.occurredAt))
      .limit(20),
    db.select().from(t.notes).where(and(eq(t.notes.accountId, account.id), eq(t.notes.kind, "next_step"), isNull(t.notes.completedAt))),
    db.select().from(t.emailThreads).where(and(eq(t.emailThreads.accountId, account.id), gt(t.emailThreads.lastMessageAt, new Date(now.getTime() - 60 * DAY)))).orderBy(desc(t.emailThreads.lastMessageAt)).limit(10),
    db.select().from(t.recommendations).where(and(eq(t.recommendations.accountId, account.id), eq(t.recommendations.status, "active"))),
  ]);
  const summaries = threads.length ? await db.select().from(t.emailSummaries).where(inArray(t.emailSummaries.threadId, threads.map((x) => x.id))) : [];
  const latest = new Map<string, t.BriefSection>();
  for (const b of briefRows) if (!latest.has(b.section)) latest.set(b.section, b);

  const evidence: PrepEvidence[] = [];
  const add = (ref: t.EvidenceRef, label: string, at: Date, url?: string) => {
    evidence.push({ ref, label, at: at.toISOString().slice(0, 10), ...(url ? { url } : {}) });
    return `E${evidence.length}`;
  };
  const lines: string[] = [];
  for (const { s, src } of changes) lines.push(`${add({ kind: "signal", signalId: s.id }, s.title, s.occurredAt, src.url)}: [${s.signalType.replace("_", " ")}${s.importance ? `, ${s.importance}` : ""}] ${s.title}${s.whyItMatters ? ` — ${s.whyItMatters}` : ""}`);
  for (const n of openSteps) lines.push(`${add({ kind: "note", noteId: n.id }, `Open next step: ${n.body}`, n.occurredAt)}: [open next step${n.dueOn ? `, due ${n.dueOn}` : ""}] ${n.body}`);
  for (const th of threads) {
    const s = summaries.find((x) => x.threadId === th.id);
    const actions = s?.actionItems.map((a) => `${a.owner === "us" ? "We" : "They"} to ${a.what}`).join("; ");
    lines.push(`${add({ kind: "email", threadId: th.id }, `Email: ${th.subject}`, th.lastMessageAt)}: [email${th.classification ? `, ${th.classification.replace(/_/g, " ")}` : ""}] "${th.subject}"${s ? `: ${s.summary}` : ""}${actions ? ` Actions: ${actions}` : ""}`);
  }
  // History with each attendee, found by meaning in the account's memory.
  if (embedder) {
    for (const a of attendees) {
      const hits = await searchMemory(db, embedder, account.id, `${a.fullName} ${a.title}`, 3).catch(() => []);
      for (const h of hits.filter((x) => x.kind === "note")) {
        if (evidence.some((e) => e.ref.kind === "note" && e.ref.noteId === h.refId)) continue;
        lines.push(`${add({ kind: "note", noteId: h.refId }, `Note: ${h.text.slice(0, 80)}`, h.occurredAt)}: [seller note about ${a.fullName}?] ${h.text}`);
      }
    }
  }

  const people = attendees
    .map((p) =>
      [
        `- ${p.fullName}, ${p.title} (relationship: ${p.relationship}${p.lastContactedAt ? `, last contacted ${p.lastContactedAt.toISOString().slice(0, 10)}` : ""})`,
        p.tenureStartedOn ? `  In role since ${p.tenureStartedOn}` : null,
        p.priorRoles.length ? `  Previously: ${p.priorRoles.map((r) => `${r.title}, ${r.organisation}`).join("; ")}` : null,
        ...p.publicStatements.map((st) => `  Said publicly: "${st.text}"`),
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .concat(meeting.otherAttendees.map((o) => `- ${o.name}${o.role ? `, ${o.role}` : ""} (not in the stakeholder list)`))
    .join("\n");

  const prompt = getPrompt("meeting.prep");
  const res = await llm.generateStructured({
    task: "meeting_prep",
    system: getPrompt("system.base").template,
    prompt: { id: prompt.id, version: prompt.version },
    messages: [
      {
        role: "user",
        content: renderPrompt(prompt, {
          company_name: account.name,
          meeting_title: meeting.title,
          meeting_date: meeting.scheduledFor?.toISOString().slice(0, 10) ?? "not set",
          today: now.toISOString().slice(0, 10),
          last_contact: lastContact ? lastContact.toISOString().slice(0, 10) : "no contact on record",
          brief: [...latest.values()].map((b) => `## ${b.section.replace("_", " ")}\n${b.summaryMd.replace(/\[\[src:[^\]]+\]\]/g, "")}`).join("\n\n") || "(no brief yet)",
          attendees: people || "(no attendees listed)",
          advice: recs.map((r) => `- ${r.kind.replace(/_/g, " ")}: ${r.title}. ${r.body}`).join("\n") || "(none)",
          evidence: lines.join("\n") || "(none)",
        }),
      },
    ],
    schema: prepOutput,
  });

  const n = (labels: string[]) => [...new Set(labels.map((l) => Number(l.trim().toUpperCase().replace(/^E/, ""))).filter((x) => Number.isInteger(x) && x >= 1 && x <= evidence.length))];
  const d = res.data;
  const prep: MeetingPrep = {
    purpose: d.purpose,
    situation: d.situation,
    attendees: d.attendees.map((a) => ({ ...a, evidence: n(a.evidence) })),
    openingAngles: d.openingAngles.slice(0, 3).map((a) => ({ ...a, evidence: n(a.evidence) })),
    objections: d.objections.slice(0, 5).map((a) => ({ ...a, evidence: n(a.evidence) })),
    // A change or an open action with no evidence is a guess: leave it out.
    changesSinceLastContact: d.changesSinceLastContact.map((a) => ({ ...a, evidence: n(a.evidence) })).filter((a) => a.evidence.length),
    openActions: d.openActions.map((a) => ({ ...a, evidence: n(a.evidence) })).filter((a) => a.evidence.length),
    evidence,
    lastContactAt: lastContact?.toISOString() ?? null,
  };

  await db
    .update(t.meetings)
    .set({ prep, prepGeneratedAt: now, prepError: null, promptId: prompt.id, promptVersion: prompt.version, model: res.provenance.model })
    .where(eq(t.meetings.id, meetingId));
  return prep;
}
