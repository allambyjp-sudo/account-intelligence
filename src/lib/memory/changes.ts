import { and, desc, eq, gt } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import * as t from "@/lib/db/schema";

export interface ChangeItem {
  kind: "signal" | "email" | "note" | "brief" | "stakeholder" | "alert" | "recommendation";
  at: Date;
  title: string;
  detail?: string | null;
  importance?: "high" | "medium" | "low" | null;
}

export interface WhatsChanged {
  since: Date | null;
  items: ChangeItem[];
  counts: Partial<Record<ChangeItem["kind"], number>>;
}

/**
 * "What's changed since you last looked" (brief, section 4.6). Everything that arrived after the
 * seller's previous visit, newest and most important first.
 */
export async function whatsChanged(db: Db, accountId: string, userId: string, since: Date | null): Promise<WhatsChanged> {
  if (!since) return { since, items: [], counts: {} };
  const [signals, threads, notes, briefs, people, alerts, recs] = await Promise.all([
    db.select().from(t.signals).where(and(eq(t.signals.accountId, accountId), eq(t.signals.relevant, true), gt(t.signals.detectedAt, since))).orderBy(desc(t.signals.detectedAt)).limit(30),
    db.select().from(t.emailThreads).where(and(eq(t.emailThreads.accountId, accountId), gt(t.emailThreads.lastMessageAt, since))).orderBy(desc(t.emailThreads.lastMessageAt)).limit(20),
    db.select().from(t.notes).where(and(eq(t.notes.accountId, accountId), gt(t.notes.createdAt, since))).orderBy(desc(t.notes.createdAt)).limit(20),
    db.select().from(t.briefSections).where(and(eq(t.briefSections.accountId, accountId), gt(t.briefSections.generatedAt, since))).orderBy(desc(t.briefSections.generatedAt)),
    db.select().from(t.stakeholders).where(and(eq(t.stakeholders.accountId, accountId), gt(t.stakeholders.updatedAt, since))),
    db.select().from(t.alerts).where(and(eq(t.alerts.accountId, accountId), eq(t.alerts.userId, userId), gt(t.alerts.createdAt, since))),
    db.select().from(t.recommendations).where(and(eq(t.recommendations.accountId, accountId), eq(t.recommendations.status, "active"), gt(t.recommendations.generatedAt, since))),
  ]);
  return summariseChanges(since, {
    signals: signals.map((s) => ({ kind: "signal", at: s.detectedAt, title: s.title, detail: s.whyItMatters ?? s.summary, importance: s.importance })),
    emails: threads.map((th) => ({ kind: "email", at: th.lastMessageAt, title: th.subject, detail: th.classification?.replace(/_/g, " ") ?? null })),
    notes: notes.map((n) => ({ kind: "note", at: n.createdAt, title: `${n.kind.replace("_", " ")} logged`, detail: n.body.slice(0, 160) })),
    briefs: briefs.map((b) => ({ kind: "brief", at: b.generatedAt, title: `Brief updated: ${b.section.replace("_", " ")}` })),
    people: people.map((p) => ({ kind: "stakeholder", at: p.updatedAt, title: `${p.fullName} updated`, detail: p.title })),
    alerts: alerts.map((a) => ({ kind: "alert", at: a.createdAt, title: a.title, importance: a.importance })),
    recs: recs.map((r) => ({ kind: "recommendation", at: r.generatedAt, title: `New advice: ${r.title}` })),
  });
}

const RANK = { high: 0, medium: 1, low: 2 } as const;

/** Pure part, so ordering and grouping are tested without a database. */
export function summariseChanges(since: Date, groups: Record<string, ChangeItem[]>): WhatsChanged {
  const items = Object.values(groups).flat();
  // Several brief sections from one research run read as one change.
  const briefs = items.filter((i) => i.kind === "brief");
  const rest = items.filter((i) => i.kind !== "brief");
  if (briefs.length > 1) rest.push({ kind: "brief", at: briefs[0]!.at, title: `Brief updated (${briefs.length} sections)` });
  else rest.push(...briefs);
  rest.sort((a, b) => (RANK[a.importance ?? "low"] ?? 2) - (RANK[b.importance ?? "low"] ?? 2) || b.at.getTime() - a.at.getTime());
  const counts: WhatsChanged["counts"] = {};
  for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  return { since, items: rest.slice(0, 15), counts };
}
