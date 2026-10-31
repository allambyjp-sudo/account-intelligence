import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import type { EmailClassification } from "@/lib/domain/enums";

const DAY = 86_400_000;

export interface InboxItem {
  thread: t.EmailThread;
  accountName: string;
  summary: t.EmailSummary | null;
  score: number;
  why: string;
}

/**
 * The seller inbox ordering: replies owed first, then dated deadlines (sooner is higher), quotes
 * and renewals, then threads waiting on the customer that have gone stale.
 */
export function priorityScore(
  thread: Pick<t.EmailThread, "classification" | "lastMessageAt" | "lastOutboundAt">,
  deadlines: Array<{ date: string }>,
  now: Date,
): { score: number; why: string } {
  const ageDays = (now.getTime() - thread.lastMessageAt.getTime()) / DAY;
  const recency = Math.max(0, 10 - ageDays);
  const soonest = deadlines
    .map((d) => new Date(`${d.date}T00:00:00Z`))
    .filter((d) => !Number.isNaN(d.getTime()) && d.getTime() >= now.getTime() - DAY)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  const daysToDeadline = soonest ? Math.ceil((soonest.getTime() - now.getTime()) / DAY) : null;
  const base: Record<EmailClassification, number> = { needs_reply: 100, deadline_mentioned: 70, quote_or_renewal: 60, waiting_on_them: 20, info_only: 0 };
  let score = (thread.classification ? base[thread.classification] : 10) + recency;
  let why = thread.classification ? thread.classification.replace(/_/g, " ") : "unclassified";
  if (daysToDeadline !== null && daysToDeadline <= 14) {
    score += 40 - daysToDeadline * 2;
    why = daysToDeadline <= 0 ? "deadline today" : `deadline in ${daysToDeadline} day${daysToDeadline === 1 ? "" : "s"}`;
  }
  if (thread.classification === "waiting_on_them" && thread.lastOutboundAt && now.getTime() - thread.lastOutboundAt.getTime() > 5 * DAY) {
    score += 35;
    why = "waiting more than 5 days: worth a nudge";
  }
  return { score, why };
}

export async function loadInbox(db: Db, userId: string, now = new Date()) {
  const accounts = await db.select({ id: t.accounts.id, name: t.accounts.name }).from(t.accounts).where(eq(t.accounts.ownerUserId, userId));
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  const threads = await db
    .select()
    .from(t.emailThreads)
    .where(and(eq(t.emailThreads.userId, userId), inArray(t.emailThreads.matchStatus, ["auto", "confirmed", "pending_confirmation"])))
    .orderBy(desc(t.emailThreads.lastMessageAt))
    .limit(200);
  const summaries = threads.length ? await db.select().from(t.emailSummaries).where(inArray(t.emailSummaries.threadId, threads.map((x) => x.id))).orderBy(desc(t.emailSummaries.createdAt)) : [];
  const latest = new Map<string, t.EmailSummary>();
  for (const s of summaries) if (!latest.has(s.threadId)) latest.set(s.threadId, s);

  const toItem = (thread: t.EmailThread): InboxItem => {
    const summary = latest.get(thread.id) ?? null;
    const allDeadlines = summaries.filter((s) => s.threadId === thread.id).flatMap((s) => s.deadlines);
    const { score, why } = priorityScore(thread, allDeadlines, now);
    return { thread, accountName: thread.accountId ? (names.get(thread.accountId) ?? "Unknown") : "Unmatched", summary, score, why };
  };
  const priority = threads
    .filter((x) => x.matchStatus !== "pending_confirmation" && x.classification !== "info_only")
    .map(toItem)
    .sort((a, b) => b.score - a.score);
  const confirm = threads.filter((x) => x.matchStatus === "pending_confirmation").map(toItem);
  const quiet = await db
    .select()
    .from(t.alerts)
    .where(and(eq(t.alerts.userId, userId), eq(t.alerts.kind, "quiet_customer"), isNull(t.alerts.dismissedAt)))
    .orderBy(desc(t.alerts.createdAt));
  const connections = await db.select().from(t.mailConnections).where(eq(t.mailConnections.userId, userId));
  return { priority, confirm, quiet, connections, accounts };
}
