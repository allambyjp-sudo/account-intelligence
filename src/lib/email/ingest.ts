import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import { EMAIL_CLASSIFICATION, type EmailClassification, type EmailProvider, type MatchMethod } from "@/lib/domain/enums";
import type { LLMProvider } from "@/lib/llm/types";
import { getPrompt, renderPrompt } from "@/lib/prompts/loader";
import { AUTO_THRESHOLD, externalParties, matchMessage, type MatchContext } from "./match";
import { ownDomains } from "./policy";
import { domainOf, lower, type MailMessage } from "./types";

export const summaryOutput = z.object({
  summary: z.string(),
  classification: z.enum(EMAIL_CLASSIFICATION),
  deadlines: z.array(z.object({ date: z.string(), what: z.string() })),
  actionItems: z.array(z.object({ owner: z.enum(["us", "them"]), what: z.string() })),
});

export const modelMatchOutput = z.object({
  accountId: z.string().nullable(),
  confidence: z.number(),
  reason: z.string(),
});

/** Everything matching needs to know about one seller's world. */
export async function loadMatchContext(db: Db, userId: string, env: Record<string, string | undefined>): Promise<MatchContext> {
  const [user] = await db.select().from(t.users).where(eq(t.users.id, userId)).limit(1);
  const accounts = await db.select().from(t.accounts).where(eq(t.accounts.ownerUserId, userId));
  const ids = accounts.map((a) => a.id);
  const [entities, contacts, rules] = await Promise.all([
    ids.length ? db.select({ accountId: t.entities.accountId, domain: t.entities.domain }).from(t.entities).where(inArray(t.entities.accountId, ids)) : [],
    ids.length
      ? db
          .select({ address: t.contactPoints.value, accountId: t.stakeholders.accountId })
          .from(t.contactPoints)
          .innerJoin(t.stakeholders, eq(t.contactPoints.stakeholderId, t.stakeholders.id))
          .where(and(inArray(t.stakeholders.accountId, ids), eq(t.contactPoints.kind, "work_email"), inArray(t.contactPoints.confidence, ["published", "verified_pattern"])))
      : [],
    db.select().from(t.emailMatchRules).where(eq(t.emailMatchRules.userId, userId)),
  ]);
  const own = new Set(ownDomains(env));
  // A seller's own address domain is always internal, even if ORG_EMAIL_DOMAINS isn't set.
  if (user?.email.includes("@")) own.add(domainOf(user.email));
  return {
    ownDomains: [...own],
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      excluded: a.emailExcluded,
      domains: [
        ...new Set(
          [...entities.filter((e) => e.accountId === a.id).map((e) => e.domain), a.websiteUrl ? new URL(a.websiteUrl).host.replace(/^www\./, "") : null]
            .filter((d): d is string => Boolean(d))
            .map(lower),
        ),
      ],
    })),
    contacts: contacts.map((c) => ({ address: lower(c.address), accountId: c.accountId })),
    rules: rules.map((r) => ({ kind: r.kind, pattern: r.pattern, accountId: r.accountId })),
  };
}

export interface IngestResult {
  messages: number;
  threadsStored: number;
  skipped: number;
  unmatched: number;
  pending: number;
  accountsTouched: string[];
  /** Accounts where something the advisor should react to arrived (quote, renewal, deadline, request). */
  meaningful: string[];
}

const RANK: Record<EmailClassification, number> = { needs_reply: 0, deadline_mentioned: 1, quote_or_renewal: 2, waiting_on_them: 3, info_only: 4 };

/**
 * Stores a batch of messages from one mailbox (brief, section 4.8): match each thread to an
 * account, summarise and classify new messages, and update the account's last contact. Mail that
 * matches no account, internal mail and mail for excluded accounts is never stored. Bodies are
 * stored only if the seller has opted in; summaries and metadata otherwise.
 */
export async function ingestMessages(
  db: Db,
  llm: LLMProvider,
  input: { userId: string; provider: EmailProvider; messages: MailMessage[]; env: Record<string, string | undefined>; now?: Date },
): Promise<IngestResult> {
  const now = input.now ?? new Date();
  const ctx = await loadMatchContext(db, input.userId, input.env);
  const [user] = await db.select().from(t.users).where(eq(t.users.id, input.userId)).limit(1);
  const res: IngestResult = { messages: input.messages.length, threadsStored: 0, skipped: 0, unmatched: 0, pending: 0, accountsTouched: [], meaningful: [] };

  const threads = new Map<string, MailMessage[]>();
  for (const m of input.messages) threads.set(m.threadId, [...(threads.get(m.threadId) ?? []), m]);

  for (const [threadId, msgs] of threads) {
    msgs.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
    const latest = msgs.at(-1)!;
    const [existing] = await db
      .select()
      .from(t.emailThreads)
      .where(and(eq(t.emailThreads.userId, input.userId), eq(t.emailThreads.provider, input.provider), eq(t.emailThreads.providerThreadId, threadId)))
      .limit(1);

    const everyone = msgs.flatMap((m) => [m.from, ...m.to, ...m.cc]);
    const combined = { from: msgs[0]!.from, to: everyone, cc: [], subject: latest.subject, preview: latest.preview };

    // A seller's decision on a thread stands; new messages don't re-match it.
    let decision: { accountId: string; status: "auto" | "pending_confirmation" | "confirmed"; method: MatchMethod; confidence: number; reason: string; candidates: string[] } | null = null;
    if (existing?.matchStatus === "confirmed" && existing.accountId) {
      decision = { accountId: existing.accountId, status: "confirmed", method: existing.matchMethod ?? "seller", confidence: 1, reason: existing.matchReason ?? "Confirmed by the seller", candidates: [existing.accountId] };
    } else if (existing?.matchStatus === "rejected") {
      res.skipped++;
      continue;
    } else {
      const m = matchMessage(combined, ctx);
      if (m.status === "skip") {
        res.skipped++;
        continue;
      }
      if (m.status === "auto" || m.status === "pending_confirmation") decision = { ...m };
      else if (m.status === "needs_model") decision = await modelMatch(llm, ctx, combined, m.candidates, m.externalDomains);
      if (!decision) {
        res.unmatched++;
        continue;
      }
    }

    const account = ctx.accounts.find((a) => a.id === decision!.accountId);
    if (!account || account.excluded) {
      res.skipped++;
      continue;
    }

    const participants = new Map<string, t.EmailParticipant>((existing?.participants ?? []).map((p) => [lower(p.address), p]));
    for (const m of msgs) {
      for (const [role, list] of [["from", [m.from]], ["to", m.to], ["cc", m.cc]] as const) {
        for (const a of list) if (!participants.has(lower(a.address))) participants.set(lower(a.address), { address: lower(a.address), ...(a.name ? { name: a.name } : {}), role });
      }
    }
    const inbound = msgs.filter((m) => m.direction === "inbound").map((m) => m.receivedAt);
    const outbound = msgs.filter((m) => m.direction === "outbound").map((m) => m.receivedAt);
    const max = (ds: Array<Date | null | undefined>) => ds.filter((d): d is Date => Boolean(d)).reduce<Date | null>((a, b) => (!a || b > a ? b : a), null);
    const values = {
      accountId: account.id,
      subject: latest.subject.slice(0, 500),
      participants: [...participants.values()],
      firstMessageAt: existing && existing.firstMessageAt < msgs[0]!.receivedAt ? existing.firstMessageAt : msgs[0]!.receivedAt,
      lastMessageAt: max([existing?.lastMessageAt, latest.receivedAt])!,
      lastInboundAt: max([existing?.lastInboundAt, ...inbound]),
      lastOutboundAt: max([existing?.lastOutboundAt, ...outbound]),
      matchMethod: decision.method,
      matchConfidence: decision.confidence.toFixed(3),
      matchStatus: decision.status,
      matchReason: decision.reason.slice(0, 300),
      candidateAccountIds: decision.candidates,
    };
    const [thread] = existing
      ? await db.update(t.emailThreads).set(values).where(eq(t.emailThreads.id, existing.id)).returning()
      : await db.insert(t.emailThreads).values({ userId: input.userId, provider: input.provider, providerThreadId: threadId, ...values }).returning();
    res.threadsStored++;
    if (decision.status === "pending_confirmation") res.pending++;

    // Summarise each message we haven't seen.
    const seen = new Set((await db.select({ id: t.emailSummaries.providerMessageId }).from(t.emailSummaries).where(eq(t.emailSummaries.threadId, thread!.id))).map((r) => r.id));
    let latestClassification: EmailClassification | null = thread!.classification;
    for (const m of msgs) {
      if (seen.has(m.providerMessageId)) continue;
      const s = await summarise(llm, m, now);
      await db
        .insert(t.emailSummaries)
        .values({
          threadId: thread!.id,
          providerMessageId: m.providerMessageId,
          summary: s.summary,
          deadlines: s.deadlines,
          actionItems: s.actionItems,
          bodyText: user?.storeEmailBodies ? (m.bodyText ?? m.preview).slice(0, 50_000) : null,
          promptId: s.prompt.id,
          promptVersion: s.prompt.version,
          model: s.model,
        })
        .onConflictDoNothing();
      if (m === latest) latestClassification = s.classification;
    }
    // The last word decides what's needed: if we sent the last message, we can't owe a reply.
    if (latest.direction === "outbound" && latestClassification === "needs_reply") latestClassification = "waiting_on_them";
    if (latestClassification !== thread!.classification) await db.update(t.emailThreads).set({ classification: latestClassification }).where(eq(t.emailThreads.id, thread!.id));

    if (decision.status === "auto" || decision.status === "confirmed") {
      await recordContact(db, account.id, values.lastMessageAt, [...participants.keys()]);
      if (!res.accountsTouched.includes(account.id)) res.accountsTouched.push(account.id);
      if (latestClassification && RANK[latestClassification] <= RANK.quote_or_renewal && !res.meaningful.includes(account.id)) res.meaningful.push(account.id);
    }
  }
  return res;
}

/** Email is contact: move last contact forward, and close an open quiet-customer alert. */
export async function recordContact(db: Db, accountId: string, at: Date, addresses: string[]) {
  await db.update(t.accounts).set({ lastContactAt: sql`greatest(${t.accounts.lastContactAt}, ${at.toISOString()}::timestamptz)` }).where(eq(t.accounts.id, accountId));
  await db.update(t.alerts).set({ dismissedAt: new Date() }).where(and(eq(t.alerts.accountId, accountId), eq(t.alerts.kind, "quiet_customer"), isNull(t.alerts.dismissedAt)));
  if (!addresses.length) return;
  const people = await db
    .select({ id: t.stakeholders.id, address: t.contactPoints.value })
    .from(t.contactPoints)
    .innerJoin(t.stakeholders, eq(t.contactPoints.stakeholderId, t.stakeholders.id))
    .where(and(eq(t.stakeholders.accountId, accountId), inArray(t.contactPoints.value, addresses)));
  for (const p of people) {
    await db.update(t.stakeholders).set({ lastContactedAt: sql`greatest(${t.stakeholders.lastContactedAt}, ${at.toISOString()}::timestamptz)` }).where(eq(t.stakeholders.id, p.id));
  }
}

async function summarise(llm: LLMProvider, m: MailMessage, now: Date) {
  const prompt = getPrompt("email.summarise");
  try {
    const res = await llm.generateStructured({
      task: "email_summary",
      system: getPrompt("system.base").template,
      prompt: { id: prompt.id, version: prompt.version },
      messages: [
        {
          role: "user",
          content: renderPrompt(prompt, {
            today: now.toISOString().slice(0, 10),
            direction: m.direction,
            from: m.from.address,
            to: [...m.to, ...m.cc].map((a) => a.address).join(", "),
            date: m.receivedAt.toISOString(),
            subject: m.subject,
            body: (m.bodyText ?? m.preview).slice(0, 6_000),
          }),
        },
      ],
      schema: summaryOutput,
    });
    return { ...res.data, prompt: { id: prompt.id, version: prompt.version }, model: res.provenance.model };
  } catch {
    // A summary failure must not lose the email: keep the preview and leave it unclassified.
    return { summary: m.preview.slice(0, 300) || m.subject, classification: null as EmailClassification | null, deadlines: [], actionItems: [], prompt: { id: "fallback.preview", version: 1 }, model: "none" };
  }
}

async function modelMatch(llm: LLMProvider, ctx: MatchContext, msg: { subject: string; preview: string; from: { address: string }; to: Array<{ address: string }> }, candidates: string[], domains: string[]) {
  const accounts = ctx.accounts.filter((a) => !a.excluded);
  if (!accounts.length) return null;
  // Name-mention candidates first; the model sees every account but is steered towards likely ones.
  const ordered = [...accounts.filter((a) => candidates.includes(a.id)), ...accounts.filter((a) => !candidates.includes(a.id))].slice(0, 60);
  const prompt = getPrompt("email.match");
  try {
    const res = await llm.generateStructured({
      task: "email_match",
      system: getPrompt("system.base").template,
      prompt: { id: prompt.id, version: prompt.version },
      messages: [
        {
          role: "user",
          content: renderPrompt(prompt, {
            parties: [...new Set(externalParties({ ...msg, cc: [] }, ctx).concat(domains))].join(", "),
            subject: msg.subject,
            preview: msg.preview.slice(0, 1_000),
            accounts: ordered.map((a) => `${a.id}: ${a.name}: ${a.domains.join(", ") || "(no domain)"}`).join("\n"),
          }),
        },
      ],
      schema: modelMatchOutput,
    });
    const id = res.data.accountId;
    if (!id || !ordered.some((a) => a.id === id)) return null;
    const confidence = Math.max(0, Math.min(1, res.data.confidence));
    return { accountId: id, status: confidence >= AUTO_THRESHOLD ? ("auto" as const) : ("pending_confirmation" as const), method: "llm" as const, confidence, reason: res.data.reason, candidates: [id] };
  } catch {
    return null;
  }
}
