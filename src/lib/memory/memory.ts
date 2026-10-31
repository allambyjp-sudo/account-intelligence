import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import type { MemoryKind } from "@/lib/domain/enums";
import type { EmbeddingProvider } from "@/lib/llm/types";

/**
 * Account memory (brief, section 4.6): notes, meetings, email summaries, classified signals and
 * brief sections, embedded for retrieval. The advisor and meeting prep pull the most relevant
 * items rather than everything.
 */

/** Splits long text on paragraph, then sentence, boundaries into chunks of at most `max` characters. */
export function chunkText(text: string, max = 1200): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const units = clean.split(/\n{2,}/).flatMap((p) => (p.length <= max ? [p] : p.split(/(?<=[.!?])\s+/)));
  const chunks: string[] = [];
  let cur = "";
  for (const u of units) {
    const piece = u.length > max ? u.match(new RegExp(`.{1,${max}}`, "gs")) ?? [u] : [u];
    for (const p of piece) {
      if (cur && cur.length + p.length + 2 > max) {
        chunks.push(cur.trim());
        cur = "";
      }
      cur += (cur ? "\n\n" : "") + p;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

/**
 * What a stored vector is compatible with: provider, model and dimension together. The same model
 * name at a different output size (Voyage allows this) must never be compared.
 */
export const modelKey = (e: EmbeddingProvider) => `${e.name}:${e.model}:${e.dimensions}`;

export interface MemoryItem {
  accountId: string;
  kind: MemoryKind;
  refId: string;
  text: string;
  occurredAt: Date;
}

/** (Re)indexes one item: old chunks for it and this model are replaced. */
export async function indexItem(db: Db, embedder: EmbeddingProvider, item: MemoryItem): Promise<number> {
  const chunks = chunkText(item.text);
  const model = modelKey(embedder);
  await db.delete(t.memoryChunks).where(and(eq(t.memoryChunks.kind, item.kind), eq(t.memoryChunks.refId, item.refId), eq(t.memoryChunks.model, model)));
  if (!chunks.length) return 0;
  const vectors = await embedder.embed(chunks, "document");
  if (vectors.some((v) => v.length !== embedder.dimensions)) {
    throw new Error(`${model} returned vectors of the wrong size; check the configured dimensions`);
  }
  await db.insert(t.memoryChunks).values(
    chunks.map((text, i) => ({ accountId: item.accountId, kind: item.kind, refId: item.refId, chunkIndex: i, text, model, embedding: vectors[i]!, occurredAt: item.occurredAt })),
  );
  return chunks.length;
}

/** Reads the text to remember for a stored item. Returns null when the item no longer exists. */
export async function loadMemoryItem(db: Db, kind: MemoryKind, refId: string): Promise<MemoryItem | null> {
  if (kind === "note" || kind === "meeting") {
    if (kind === "note") {
      const [n] = await db.select().from(t.notes).where(eq(t.notes.id, refId)).limit(1);
      return n ? { accountId: n.accountId, kind, refId, text: `${n.kind.replace("_", " ")}: ${n.body}`, occurredAt: n.occurredAt } : null;
    }
    const [m] = await db.select().from(t.meetings).where(eq(t.meetings.id, refId)).limit(1);
    if (!m) return null;
    const prep = m.prep ? JSON.stringify(m.prep).slice(0, 4000) : "";
    return { accountId: m.accountId, kind, refId, text: `Meeting: ${m.title}\n${prep}`, occurredAt: m.scheduledFor ?? m.createdAt };
  }
  if (kind === "email_summary") {
    const [row] = await db
      .select({ s: t.emailSummaries, th: t.emailThreads })
      .from(t.emailSummaries)
      .innerJoin(t.emailThreads, eq(t.emailSummaries.threadId, t.emailThreads.id))
      .where(eq(t.emailSummaries.id, refId))
      .limit(1);
    if (!row?.th.accountId) return null;
    return { accountId: row.th.accountId, kind, refId, text: `Email "${row.th.subject}": ${row.s.summary}`, occurredAt: row.th.lastMessageAt };
  }
  if (kind === "signal") {
    const [s] = await db.select().from(t.signals).where(eq(t.signals.id, refId)).limit(1);
    if (!s || !s.relevant) return null;
    return { accountId: s.accountId, kind, refId, text: [s.title, s.summary, s.whyItMatters].filter(Boolean).join("\n"), occurredAt: s.occurredAt };
  }
  const [b] = await db.select().from(t.briefSections).where(eq(t.briefSections.id, refId)).limit(1);
  if (!b) return null;
  return { accountId: b.accountId, kind, refId, text: `${b.section.replace("_", " ")}: ${b.summaryMd.replace(/\[\[src:[^\]]+\]\]/g, "")}`, occurredAt: b.generatedAt };
}

export interface MemoryHit {
  kind: MemoryKind;
  refId: string;
  text: string;
  occurredAt: Date;
  distance: number;
}

/** The account's memory items closest to the query (cosine distance), one hit per item. */
export async function searchMemory(db: Db, embedder: EmbeddingProvider, accountId: string, query: string, k = 8): Promise<MemoryHit[]> {
  if (!query.trim()) return [];
  const [vec] = await embedder.embed([query], "query");
  const literal = `[${vec!.join(",")}]`;
  const rows = await db.execute<{ kind: MemoryKind; ref_id: string; text: string; occurred_at: Date; distance: number }>(sql`
    SELECT DISTINCT ON (ref_id) kind, ref_id, text, occurred_at, embedding <=> ${literal}::vector AS distance
    FROM ${t.memoryChunks}
    WHERE account_id = ${accountId} AND model = ${modelKey(embedder)}
    ORDER BY ref_id, distance
  `);
  return rows.rows
    .map((r) => ({ kind: r.kind, refId: r.ref_id, text: r.text, occurredAt: new Date(r.occurred_at), distance: Number(r.distance) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, k);
}
