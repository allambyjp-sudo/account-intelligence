import { createHash } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import type { EmbeddingProvider, LLMProvider } from "@/lib/llm/types";
import { searchMemory } from "@/lib/memory/memory";
import { getPrompt, renderPrompt } from "@/lib/prompts/loader";

const DAY = 86_400_000;

/** One piece of evidence the advisor may cite, labelled E1..En in the prompt. */
export interface EvidenceItem {
  label: string;
  ref: t.EvidenceRef;
  at: Date;
  text: string;
}

export interface AdvisorInputs {
  account: t.Account;
  evidence: EvidenceItem[];
  stakeholders: t.Stakeholder[];
  briefText: string;
  facts: string[];
  fingerprint: string;
}

/**
 * Everything the advisor may draw on (brief, section 4.5): the brief, live signals, account memory
 * and the email feed. The fingerprint is a hash of what was gathered; the advisor only re-runs
 * when it changes.
 */
export async function gatherAdvisorInputs(db: Db, embedder: EmbeddingProvider | null, accountId: string, now = new Date()): Promise<AdvisorInputs | null> {
  const [account] = await db.select().from(t.accounts).where(eq(t.accounts.id, accountId)).limit(1);
  if (!account) return null;
  const since90 = new Date(now.getTime() - 90 * DAY);

  const [briefRows, signals, notes, threads, people] = await Promise.all([
    db.select().from(t.briefSections).where(eq(t.briefSections.accountId, accountId)).orderBy(desc(t.briefSections.version)),
    db
      .select({ s: t.signals, src: t.sources })
      .from(t.signals)
      .innerJoin(t.sources, eq(t.signals.sourceId, t.sources.id))
      .where(and(eq(t.signals.accountId, accountId), eq(t.signals.relevant, true), gt(t.signals.occurredAt, since90), inArray(t.signals.importance, ["high", "medium"])))
      .orderBy(desc(t.signals.occurredAt))
      .limit(25),
    db
      .select()
      .from(t.notes)
      .where(and(eq(t.notes.accountId, accountId), or(gt(t.notes.occurredAt, since90), and(eq(t.notes.kind, "next_step"), isNull(t.notes.completedAt)))))
      .orderBy(desc(t.notes.occurredAt))
      .limit(25),
    db.select().from(t.emailThreads).where(and(eq(t.emailThreads.accountId, accountId), gt(t.emailThreads.lastMessageAt, new Date(now.getTime() - 45 * DAY)))).orderBy(desc(t.emailThreads.lastMessageAt)).limit(15),
    db.select().from(t.stakeholders).where(eq(t.stakeholders.accountId, accountId)),
  ]);
  const summaries = threads.length
    ? await db.select().from(t.emailSummaries).where(inArray(t.emailSummaries.threadId, threads.map((x) => x.id))).orderBy(desc(t.emailSummaries.createdAt))
    : [];

  const latest = new Map<string, t.BriefSection>();
  for (const b of briefRows) if (!latest.has(b.section)) latest.set(b.section, b);
  const briefText = [...latest.values()].map((b) => `## ${b.section.replace("_", " ")}\n${b.summaryMd.replace(/\[\[src:[^\]]+\]\]/g, "")}`).join("\n\n") || "(no brief yet)";

  const evidence: EvidenceItem[] = [];
  const add = (ref: t.EvidenceRef, at: Date, text: string) => evidence.push({ label: `E${evidence.length + 1}`, ref, at, text });
  for (const { s, src } of signals) add({ kind: "signal", signalId: s.id }, s.occurredAt, `[${s.importance} ${s.signalType.replace("_", " ")}] ${s.title}${s.whyItMatters ? ` — ${s.whyItMatters}` : ""} (${src.publisher ?? new URL(src.url).host})`);
  for (const n of notes) add({ kind: "note", noteId: n.id }, n.occurredAt, `[seller ${n.kind.replace("_", " ")}${n.completedAt ? ", done" : ""}${n.dueOn ? `, due ${n.dueOn}` : ""}] ${n.body}`);
  for (const th of threads) {
    const s = summaries.find((x) => x.threadId === th.id);
    add({ kind: "email", threadId: th.id }, th.lastMessageAt, `[email${th.classification ? `, ${th.classification.replace(/_/g, " ")}` : ""}] "${th.subject}"${s ? `: ${s.summary}` : ""}`);
  }
  // Older memory that bears on what's happening now, found by meaning rather than date.
  if (embedder && signals.length) {
    const query = signals.slice(0, 3).map(({ s }) => s.title).join("; ");
    const hits = await searchMemory(db, embedder, accountId, query, 5).catch(() => []);
    for (const h of hits) {
      if (h.kind === "note" && !evidence.some((e) => e.ref.kind === "note" && e.ref.noteId === h.refId)) add({ kind: "note", noteId: h.refId }, h.occurredAt, `[older seller note] ${h.text}`);
    }
  }

  // Facts computed in code, so the model doesn't have to infer them.
  const facts: string[] = [];
  const daysSince = account.lastContactAt ? Math.floor((now.getTime() - account.lastContactAt.getTime()) / DAY) : null;
  facts.push(daysSince === null ? "No contact with this account is on record." : `Last contact was ${daysSince} days ago.`);
  for (const p of people) {
    if (p.relationship === "champion" && p.employmentStatus === "departed") facts.push(`Champion ${p.fullName} has left the company.`);
    else if (p.relationship === "champion" && p.lastContactedAt && now.getTime() - p.lastContactedAt.getTime() > 45 * DAY)
      facts.push(`Champion ${p.fullName} hasn't been contacted for ${Math.floor((now.getTime() - p.lastContactedAt.getTime()) / DAY)} days.`);
  }

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        brief: [...latest.values()].map((b) => b.id).sort(),
        evidence: evidence.map((e) => JSON.stringify(e.ref)).sort(),
        people: people.map((p) => `${p.id}:${p.relationship}:${p.employmentStatus}`).sort(),
        facts,
      }),
    )
    .digest("hex");

  return { account, evidence, stakeholders: people, briefText, facts, fingerprint };
}

const evidenceRefs = z.array(z.string()).describe('Evidence labels, like "E2". At least one.');
export const advisorOutput = z.object({
  nextBestActions: z.array(z.object({ title: z.string(), who: z.string().nullable().describe("Full name of the person to contact, from the stakeholder list, or null."), why: z.string(), evidence: evidenceRefs })),
  triggerAlerts: z.array(z.object({ title: z.string(), whatChanged: z.string(), whyItMatters: z.string(), evidence: evidenceRefs })),
  talkingPoints: z.array(z.object({ title: z.string(), angle: z.string(), evidence: evidenceRefs })),
  riskFlags: z.array(z.object({ title: z.string(), detail: z.string(), kind: z.enum(["competitor", "budget", "champion", "other"]), evidence: evidenceRefs })),
});

export interface AdvisorResult {
  status: "refreshed" | "unchanged" | "no_evidence";
  created: number;
  dropped: number;
}

/** Runs the advisor when its inputs have changed. Old advice is superseded, not deleted. */
export async function refreshAdvisor(db: Db, llm: LLMProvider, embedder: EmbeddingProvider | null, accountId: string, opts: { force?: boolean; now?: Date } = {}): Promise<AdvisorResult> {
  const now = opts.now ?? new Date();
  const inputs = await gatherAdvisorInputs(db, embedder, accountId, now);
  if (!inputs) return { status: "unchanged", created: 0, dropped: 0 };
  if (!opts.force && inputs.account.advisorFingerprint === inputs.fingerprint) return { status: "unchanged", created: 0, dropped: 0 };
  if (!inputs.evidence.length && inputs.briefText === "(no brief yet)") return { status: "no_evidence", created: 0, dropped: 0 };

  const prompt = getPrompt("advisor.recommend");
  const res = await llm.generateStructured({
    task: "advisor",
    system: getPrompt("system.base").template,
    prompt: { id: prompt.id, version: prompt.version },
    messages: [
      {
        role: "user",
        content: renderPrompt(prompt, {
          company_name: inputs.account.name,
          today: now.toISOString().slice(0, 10),
          brief: inputs.briefText,
          facts: inputs.facts.map((f) => `- ${f}`).join("\n"),
          stakeholders:
            inputs.stakeholders.map((p) => `- ${p.fullName}, ${p.title} (${p.relationship}${p.employmentStatus !== "current" ? `, ${p.employmentStatus}` : ""})`).join("\n") || "(none known)",
          evidence: inputs.evidence.map((e) => `${e.label} (${e.at.toISOString().slice(0, 10)}): ${e.text}`).join("\n") || "(none)",
        }),
      },
    ],
    schema: advisorOutput,
  });

  const byLabel = new Map(inputs.evidence.map((e) => [e.label, e.ref]));
  const resolve = (labels: string[]) => [...new Set(labels.map((l) => l.trim().toUpperCase()))].map((l) => byLabel.get(l)).filter((r): r is t.EvidenceRef => Boolean(r));
  const person = (name: string | null) => (name ? inputs.stakeholders.find((p) => p.fullName.toLowerCase() === name.trim().toLowerCase())?.id ?? null : null);

  type Row = Omit<typeof t.recommendations.$inferInsert, "accountId" | "inputFingerprint" | "promptId" | "promptVersion" | "model">;
  const rows: Row[] = [];
  let dropped = 0;
  const push = (row: Row) => {
    // Every suggestion links to its evidence (brief, section 4.5). No valid evidence, no suggestion.
    if (!(row.evidence as t.EvidenceRef[]).length) dropped++;
    else rows.push(row);
  };
  const d = res.data;
  for (const a of d.nextBestActions.slice(0, 2)) push({ kind: "next_best_action", title: a.title, body: a.why, targetStakeholderId: person(a.who), evidence: resolve(a.evidence) });
  for (const a of d.triggerAlerts.slice(0, 4)) push({ kind: "trigger_alert", title: a.title, body: `${a.whatChanged} ${a.whyItMatters}`.trim(), evidence: resolve(a.evidence) });
  for (const a of d.talkingPoints.slice(0, 3)) push({ kind: "talking_point", title: a.title, body: a.angle, evidence: resolve(a.evidence) });
  for (const a of d.riskFlags.slice(0, 4)) push({ kind: "risk_flag", title: a.title, body: `${a.kind === "other" ? "" : `${a.kind[0]!.toUpperCase()}${a.kind.slice(1)}: `}${a.detail}`, evidence: resolve(a.evidence) });

  await db.transaction(async (tx) => {
    await tx.update(t.recommendations).set({ status: "superseded" }).where(and(eq(t.recommendations.accountId, accountId), eq(t.recommendations.status, "active")));
    if (rows.length) {
      await tx.insert(t.recommendations).values(
        rows.map((r) => ({ ...r, accountId, inputFingerprint: inputs.fingerprint, promptId: prompt.id, promptVersion: prompt.version, model: res.provenance.model, generatedAt: now })),
      );
    }
    await tx.update(t.accounts).set({ advisorFingerprint: inputs.fingerprint, advisorRefreshedAt: now }).where(eq(t.accounts.id, accountId));
  });
  return { status: "refreshed", created: rows.length, dropped };
}
