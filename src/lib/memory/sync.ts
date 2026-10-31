import { and, desc, eq, isNotNull, notInArray } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import type { MemoryKind } from "@/lib/domain/enums";
import type { EmbeddingProvider } from "@/lib/llm/types";
import { indexItem, loadMemoryItem, modelKey } from "./memory";

/** Indexes everything for an account that isn't yet embedded with the current model. Idempotent. */
export async function syncAccountMemory(db: Db, embedder: EmbeddingProvider, accountId: string): Promise<number> {
  const indexed = await db
    .selectDistinct({ refId: t.memoryChunks.refId })
    .from(t.memoryChunks)
    .where(and(eq(t.memoryChunks.accountId, accountId), eq(t.memoryChunks.model, modelKey(embedder))));
  const done = indexed.map((r) => r.refId);
  const notDone = (col: AnyPgColumn) => (done.length ? notInArray(col, done) : undefined);

  const [notes, meetings, signals, briefs, summaries] = await Promise.all([
    db.select({ id: t.notes.id }).from(t.notes).where(and(eq(t.notes.accountId, accountId), notDone(t.notes.id))),
    db.select({ id: t.meetings.id }).from(t.meetings).where(and(eq(t.meetings.accountId, accountId), isNotNull(t.meetings.prep), notDone(t.meetings.id))),
    db
      .select({ id: t.signals.id })
      .from(t.signals)
      .where(and(eq(t.signals.accountId, accountId), eq(t.signals.relevant, true), isNotNull(t.signals.classifiedAt), notDone(t.signals.id)))
      .orderBy(desc(t.signals.occurredAt))
      .limit(200),
    db.select({ id: t.briefSections.id, section: t.briefSections.section, version: t.briefSections.version }).from(t.briefSections).where(eq(t.briefSections.accountId, accountId)).orderBy(desc(t.briefSections.version)),
    db
      .select({ id: t.emailSummaries.id })
      .from(t.emailSummaries)
      .innerJoin(t.emailThreads, eq(t.emailSummaries.threadId, t.emailThreads.id))
      .where(and(eq(t.emailThreads.accountId, accountId), notDone(t.emailSummaries.id))),
  ]);
  // Only the latest version of each brief section is memory; older ones are history.
  const latestBriefs = new Map<string, string>();
  for (const b of briefs) if (!latestBriefs.has(b.section)) latestBriefs.set(b.section, b.id);

  const todo: Array<[MemoryKind, string]> = [
    ...notes.map((n) => ["note", n.id] as [MemoryKind, string]),
    ...meetings.map((m) => ["meeting", m.id] as [MemoryKind, string]),
    ...signals.map((s) => ["signal", s.id] as [MemoryKind, string]),
    ...[...latestBriefs.values()].filter((id) => !done.includes(id)).map((id) => ["brief_section", id] as [MemoryKind, string]),
    ...summaries.map((s) => ["email_summary", s.id] as [MemoryKind, string]),
  ];
  let chunks = 0;
  for (const [kind, refId] of todo) {
    const item = await loadMemoryItem(db, kind, refId);
    if (item) chunks += await indexItem(db, embedder, item);
  }
  return chunks;
}
