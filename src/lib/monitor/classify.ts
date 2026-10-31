import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import { IMPORTANCE, SIGNAL_TYPE } from "@/lib/domain/enums";
import type { LLMProvider } from "@/lib/llm/types";
import { getPrompt, renderPrompt } from "@/lib/prompts/loader";

export const classifyOutput = z.object({
  items: z.array(
    z.object({
      ref: z.string(),
      aboutThisCompany: z.boolean().describe("False when the item only mentions a similar name or is about a different organisation."),
      signalType: z.enum(SIGNAL_TYPE.filter((s) => s !== "unclassified") as [string, ...string[]]),
      importance: z.enum(IMPORTANCE),
      summary: z.string().describe("One sentence on what happened."),
      whyItMatters: z.string().describe("One sentence on why it matters to the company, and so to someone selling to them."),
    }),
  ),
});

export interface ClassifyResult {
  classified: number;
  high: t.Signal[];
}

const BATCH = 15;

/**
 * Classifies an account's unclassified signals by type and importance (brief, section 4.4), in
 * batches. High-importance items raise an alert for the account's owner.
 */
export async function classifySignals(db: Db, llm: LLMProvider, accountId: string, now = new Date()): Promise<ClassifyResult> {
  const [account] = await db.select().from(t.accounts).where(eq(t.accounts.id, accountId)).limit(1);
  if (!account) return { classified: 0, high: [] };
  const pending = await db
    .select({ s: t.signals, src: t.sources })
    .from(t.signals)
    .innerJoin(t.sources, eq(t.signals.sourceId, t.sources.id))
    .where(and(eq(t.signals.accountId, accountId), isNull(t.signals.classifiedAt)))
    .orderBy(asc(t.signals.detectedAt))
    .limit(BATCH);
  if (!pending.length) return { classified: 0, high: [] };

  const [entity] = await db.select().from(t.entities).where(and(eq(t.entities.accountId, accountId), eq(t.entities.isPrimary, true))).limit(1);
  const stack = await db.select().from(t.techStackItems).where(eq(t.techStackItems.accountId, accountId));
  const people = await db.select().from(t.stakeholders).where(eq(t.stakeholders.accountId, accountId));
  const context = [
    entity?.legalName && `Legal name: ${entity.legalName}`,
    entity?.industry && `Industry: ${entity.industry}`,
    entity?.domain && `Website: ${entity.domain}`,
    stack.length ? `Known technology: ${stack.slice(0, 25).map((s) => `${s.vendor} ${s.product}`).join(", ")}` : null,
    people.length ? `Known people: ${people.slice(0, 15).map((p) => `${p.fullName} (${p.title})`).join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const items = pending
    .map(({ s, src }, i) =>
      [`<item ref="I${i + 1}" channel="${s.channel}" date="${s.occurredAt.toISOString().slice(0, 10)}" source="${src.publisher ?? new URL(src.url).host}">`, s.title, s.summary ?? "", "</item>"].join("\n"),
    )
    .join("\n\n");

  const prompt = getPrompt("monitor.classify");
  const res = await llm.generateStructured({
    task: "classify",
    system: getPrompt("system.base").template,
    prompt: { id: prompt.id, version: prompt.version },
    messages: [{ role: "user", content: renderPrompt(prompt, { company_name: account.name, context: context || "(none)", items }) }],
    schema: classifyOutput,
  });

  const classifier = `${prompt.id}@${prompt.version}:${res.provenance.model}`;
  const high: t.Signal[] = [];
  let classified = 0;
  for (const out of res.data.items) {
    const idx = Number(out.ref.replace(/^I/i, "")) - 1;
    const target = pending[idx]?.s;
    if (!target) continue;
    const relevant = out.aboutThisCompany;
    const [row] = await db
      .update(t.signals)
      .set({
        signalType: (relevant ? out.signalType : "other") as t.Signal["signalType"],
        importance: relevant ? out.importance : "low",
        summary: out.summary,
        whyItMatters: relevant ? out.whyItMatters : null,
        relevant,
        classifiedAt: now,
        classifier,
      })
      .where(and(eq(t.signals.id, target.id), isNull(t.signals.classifiedAt)))
      .returning();
    if (!row) continue;
    classified++;
    if (row.relevant && row.importance === "high") high.push(row);
  }

  for (const s of high) {
    await db.insert(t.alerts).values({
      userId: account.ownerUserId,
      accountId,
      signalId: s.id,
      kind: "signal",
      importance: "high",
      title: s.title.slice(0, 200),
      body: s.whyItMatters,
    });
  }
  return { classified, high };
}

/** Accounts with unclassified signals, for the sweep that catches anything a failed job left behind. */
export async function accountsWithPendingSignals(db: Db): Promise<string[]> {
  const rows = await db.selectDistinct({ id: t.signals.accountId }).from(t.signals).where(isNull(t.signals.classifiedAt));
  return rows.map((r) => r.id);
}

