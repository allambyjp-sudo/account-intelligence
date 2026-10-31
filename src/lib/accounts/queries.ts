import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import { CONFIDENCE, STAKEHOLDER_FUNCTION, type BriefSectionKind, type Importance } from "@/lib/domain/enums";
import { scoreUrgency, type Urgency } from "./urgency";

export interface PortfolioRow {
  account: t.Account;
  primaryEntity: t.Entity | null;
  urgency: Urgency;
  lastSignalAt: Date | null;
}

/** Every account the seller owns, most urgent first. */
export async function loadPortfolio(db: Db, userId: string, now = new Date()): Promise<PortfolioRow[]> {
  const accounts = await db.select().from(t.accounts).where(eq(t.accounts.ownerUserId, userId)).orderBy(asc(t.accounts.name));
  if (!accounts.length) return [];
  const ids = accounts.map((a) => a.id);

  const [entities, alertCounts, lastSignals] = await Promise.all([
    db.select().from(t.entities).where(and(inArray(t.entities.accountId, ids), eq(t.entities.isPrimary, true))),
    db
      .select({ accountId: t.alerts.accountId, importance: t.alerts.importance, n: sql<number>`count(*)::int` })
      .from(t.alerts)
      .where(and(inArray(t.alerts.accountId, ids), eq(t.alerts.userId, userId), isNull(t.alerts.dismissedAt)))
      .groupBy(t.alerts.accountId, t.alerts.importance),
    db
      .select({ accountId: t.signals.accountId, at: sql<Date>`max(${t.signals.occurredAt})` })
      .from(t.signals)
      .where(and(inArray(t.signals.accountId, ids), eq(t.signals.relevant, true)))
      .groupBy(t.signals.accountId),
  ]);

  const rows = accounts.map((account) => {
    const openAlerts: Record<Importance, number> = { high: 0, medium: 0, low: 0 };
    for (const c of alertCounts) if (c.accountId === account.id) openAlerts[c.importance] = c.n;
    const last = lastSignals.find((s) => s.accountId === account.id)?.at;
    return {
      account,
      primaryEntity: entities.find((e) => e.accountId === account.id) ?? null,
      urgency: scoreUrgency({
        openAlerts,
        isKeyAccount: account.isKeyAccount,
        lastContactAt: account.lastContactAt,
        quietAfterDays: account.quietAfterDays,
        now,
      }),
      lastSignalAt: last ? new Date(last) : null,
    };
  });
  return rows.sort((a, b) => b.urgency.score - a.urgency.score || a.account.name.localeCompare(b.account.name));
}

export type TimelineItem =
  | { kind: "signal"; at: Date; signal: t.Signal; source: t.Source }
  | { kind: "email"; at: Date; thread: t.EmailThread; latestSummary: t.EmailSummary | null };

export interface AccountPage {
  account: t.Account;
  primaryEntity: t.Entity | null;
  entities: t.Entity[];
  brief: Partial<Record<BriefSectionKind, t.BriefSection>>;
  stakeholders: Array<t.Stakeholder & { contacts: t.ContactPoint[] }>;
  techStack: t.TechStackItem[];
  timeline: TimelineItem[];
  recommendations: t.Recommendation[];
  alerts: t.Alert[];
  /** Every source cited anywhere on the page, by id. */
  sources: Map<string, t.Source>;
  workerLastSeen: Date | null;
  latestRun: t.ResearchRun | null;
  prices: Array<{ tradeDate: string; close: number; currency: string }>;
  notes: t.Note[];
  /** Labels for recommendation evidence that isn't a source: signals, notes and emails. */
  evidenceLabels: Map<string, { label: string; url?: string }>;
}

/** Everything the account page shows. Returns null when the account isn't the seller's. */
export async function loadAccountPage(db: Db, userId: string, accountId: string): Promise<AccountPage | null> {
  const [account] = await db
    .select()
    .from(t.accounts)
    .where(and(eq(t.accounts.id, accountId), eq(t.accounts.ownerUserId, userId)))
    .limit(1);
  if (!account) return null;

  const [entities, briefRows, stakeholders, techStack, signalRows, threads, recommendations, alerts, heartbeat, runs] = await Promise.all([
    db.select().from(t.entities).where(eq(t.entities.accountId, accountId)).orderBy(desc(t.entities.isPrimary), asc(t.entities.legalName)),
    db.select().from(t.briefSections).where(eq(t.briefSections.accountId, accountId)).orderBy(desc(t.briefSections.version)),
    db.select().from(t.stakeholders).where(eq(t.stakeholders.accountId, accountId)).orderBy(asc(t.stakeholders.fullName)),
    db.select().from(t.techStackItems).where(eq(t.techStackItems.accountId, accountId)).orderBy(asc(t.techStackItems.vendor)),
    db
      .select({ signal: t.signals, source: t.sources })
      .from(t.signals)
      .innerJoin(t.sources, eq(t.signals.sourceId, t.sources.id))
      .where(and(eq(t.signals.accountId, accountId), eq(t.signals.relevant, true)))
      .orderBy(desc(t.signals.occurredAt))
      .limit(100),
    db.select().from(t.emailThreads).where(eq(t.emailThreads.accountId, accountId)).orderBy(desc(t.emailThreads.lastMessageAt)).limit(50),
    db
      .select()
      .from(t.recommendations)
      .where(and(eq(t.recommendations.accountId, accountId), eq(t.recommendations.status, "active")))
      .orderBy(asc(t.recommendations.kind), desc(t.recommendations.generatedAt)),
    db
      .select()
      .from(t.alerts)
      .where(and(eq(t.alerts.accountId, accountId), eq(t.alerts.userId, userId), isNull(t.alerts.dismissedAt)))
      .orderBy(desc(t.alerts.createdAt)),
    db.select({ at: sql<Date | null>`max(${t.workerHeartbeats.lastBeatAt})` }).from(t.workerHeartbeats),
    db.select().from(t.researchRuns).where(eq(t.researchRuns.accountId, accountId)).orderBy(desc(t.researchRuns.createdAt)).limit(1),
  ]);

  const contacts = stakeholders.length
    ? await db.select().from(t.contactPoints).where(inArray(t.contactPoints.stakeholderId, stakeholders.map((s) => s.id)))
    : [];
  const summaries = threads.length
    ? await db.select().from(t.emailSummaries).where(inArray(t.emailSummaries.threadId, threads.map((th) => th.id))).orderBy(desc(t.emailSummaries.createdAt))
    : [];

  // Seniority order for people; strongest evidence first for the tech stack.
  stakeholders.sort((a, b) => STAKEHOLDER_FUNCTION.indexOf(a.function) - STAKEHOLDER_FUNCTION.indexOf(b.function));
  techStack.sort(
    (a, b) =>
      Number(b.verification === "verified") - Number(a.verification === "verified") ||
      CONFIDENCE.indexOf(a.confidence) - CONFIDENCE.indexOf(b.confidence),
  );

  const brief: AccountPage["brief"] = {};
  for (const row of briefRows) brief[row.section] ??= row; // rows arrive newest version first

  const citedIds = new Set<string>();
  for (const row of [...entities, ...stakeholders, ...techStack, ...contacts]) if (row.sourceId) citedIds.add(row.sourceId);
  for (const s of stakeholders) for (const st of s.publicStatements) citedIds.add(st.sourceId);
  for (const b of Object.values(brief)) for (const id of b?.sourceIds ?? []) citedIds.add(id);
  for (const r of recommendations) for (const e of r.evidence) if (e.kind === "source") citedIds.add(e.sourceId);
  const sourceRows = citedIds.size ? await db.select().from(t.sources).where(inArray(t.sources.id, [...citedIds])) : [];
  const sources = new Map(sourceRows.map((s) => [s.id, s]));
  for (const { source } of signalRows) sources.set(source.id, source);

  const timeline: TimelineItem[] = [
    ...signalRows.map(({ signal, source }) => ({ kind: "signal" as const, at: signal.occurredAt, signal, source })),
    ...threads.map((thread) => ({
      kind: "email" as const,
      at: thread.lastMessageAt,
      thread,
      latestSummary: summaries.find((s) => s.threadId === thread.id) ?? null,
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  const notes = await db
    .select()
    .from(t.notes)
    .where(eq(t.notes.accountId, accountId))
    .orderBy(desc(t.notes.occurredAt))
    .limit(30);

  // Recommendation evidence that points at signals, notes or emails, resolved to something readable.
  const evidenceLabels = new Map<string, { label: string; url?: string }>();
  const evSignals = recommendations.flatMap((r) => r.evidence.flatMap((e) => (e.kind === "signal" ? [e.signalId] : [])));
  const evNotes = recommendations.flatMap((r) => r.evidence.flatMap((e) => (e.kind === "note" ? [e.noteId] : [])));
  const evThreads = recommendations.flatMap((r) => r.evidence.flatMap((e) => (e.kind === "email" ? [e.threadId] : [])));
  if (evSignals.length) {
    const rows = await db.select({ s: t.signals, src: t.sources }).from(t.signals).innerJoin(t.sources, eq(t.signals.sourceId, t.sources.id)).where(inArray(t.signals.id, evSignals));
    for (const { s, src } of rows) evidenceLabels.set(s.id, { label: s.title, url: src.url });
  }
  if (evNotes.length) {
    for (const n of await db.select().from(t.notes).where(inArray(t.notes.id, evNotes))) evidenceLabels.set(n.id, { label: `Your ${n.kind.replace("_", " ")}: ${n.body.slice(0, 80)}${n.body.length > 80 ? "…" : ""}` });
  }
  if (evThreads.length) {
    for (const th of await db.select().from(t.emailThreads).where(inArray(t.emailThreads.id, evThreads))) evidenceLabels.set(th.id, { label: `Email: ${th.subject}` });
  }

  const primaryEntity = entities.find((e) => e.isPrimary) ?? null;
  const prices = primaryEntity?.ticker
    ? (
        await db
          .select()
          .from(t.pricePoints)
          .where(eq(t.pricePoints.entityId, primaryEntity.id))
          .orderBy(desc(t.pricePoints.tradeDate))
          .limit(90)
      )
        .reverse()
        .map((p) => ({ tradeDate: p.tradeDate, close: Number(p.close), currency: p.currency }))
    : [];
  const heartbeatAt = heartbeat[0]?.at;
  return {
    account,
    primaryEntity,
    entities,
    brief,
    stakeholders: stakeholders.map((s) => ({ ...s, contacts: contacts.filter((c) => c.stakeholderId === s.id) })),
    techStack,
    timeline,
    recommendations,
    alerts,
    sources,
    workerLastSeen: heartbeatAt ? new Date(heartbeatAt) : null,
    latestRun: runs[0] ?? null,
    prices,
    notes,
    evidenceLabels,
  };
}
