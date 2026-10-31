"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import { recordContact, loadMatchContext } from "@/lib/email/ingest";
import { externalParties, ruleFromConfirmation } from "@/lib/email/match";
import { domainOf } from "@/lib/email/types";
import { advisorRefreshJob, memorySyncJob } from "@/lib/jobs/advisor";
import { mailSyncJob } from "@/lib/jobs/email";
import { getJobSender } from "@/lib/jobs/sender";

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

async function ownedThread(userId: string, threadId: unknown) {
  const [thread] = await getDb()
    .select()
    .from(t.emailThreads)
    .where(and(eq(t.emailThreads.id, z.uuid().parse(threadId)), eq(t.emailThreads.userId, userId)))
    .limit(1);
  if (!thread) throw new Error("Thread not found");
  return thread;
}

/** The synthetic mailbox: always allowed, because it holds no real data. */
export async function connectSynthetic() {
  const user = await requireUser("/inbox");
  const [conn] = await getDb()
    .insert(t.mailConnections)
    .values({ userId: user.id, provider: "synthetic", mailbox: "Synthetic test mailbox" })
    .onConflictDoUpdate({ target: [t.mailConnections.userId, t.mailConnections.provider], set: { status: "active", lastError: null } })
    .returning();
  await (await getJobSender()).send(mailSyncJob, { connectionId: conn!.id }, { singletonKey: conn!.id });
  redirect("/inbox?connected=synthetic");
}

export async function syncNow(form: FormData) {
  const user = await requireUser("/inbox");
  const id = z.uuid().parse(str(form, "connectionId"));
  const [conn] = await getDb().select().from(t.mailConnections).where(and(eq(t.mailConnections.id, id), eq(t.mailConnections.userId, user.id))).limit(1);
  if (!conn) throw new Error("Connection not found");
  await (await getJobSender()).send(mailSyncJob, { connectionId: conn.id }, { singletonKey: conn.id });
  redirect("/inbox?syncing=1");
}

export async function disconnectMailbox(form: FormData) {
  const user = await requireUser("/inbox");
  const id = z.uuid().parse(str(form, "connectionId"));
  // Tokens are deleted, not just flagged; stored summaries stay with their accounts.
  await getDb()
    .update(t.mailConnections)
    .set({ status: "disconnected", sealedTokens: null, subscriptionId: null, subscriptionExpiresAt: null })
    .where(and(eq(t.mailConnections.id, id), eq(t.mailConnections.userId, user.id)));
  revalidatePath("/inbox");
}

/** Confirm (or reassign) a thread. The confirmation becomes a rule so the sender matches by itself next time. */
export async function confirmThread(form: FormData) {
  const user = await requireUser("/inbox");
  const thread = await ownedThread(user.id, str(form, "threadId"));
  const accountId = z.uuid().parse(str(form, "accountId"));
  const db = getDb();
  const [account] = await db.select().from(t.accounts).where(and(eq(t.accounts.id, accountId), eq(t.accounts.ownerUserId, user.id))).limit(1);
  if (!account) throw new Error("Account not found");
  if (account.emailExcluded) {
    // Confirming mail onto an excluded account means it shouldn't be stored at all.
    await db.delete(t.emailThreads).where(eq(t.emailThreads.id, thread.id));
    revalidatePath("/inbox");
    return;
  }
  await db
    .update(t.emailThreads)
    .set({ accountId, matchStatus: "confirmed", matchConfidence: "1.000", matchReason: "Confirmed by you", candidateAccountIds: [accountId] })
    .where(eq(t.emailThreads.id, thread.id));

  const ctx = await loadMatchContext(db, user.id, process.env);
  const parties = externalParties({ from: thread.participants.find((p) => p.role === "from") ?? { address: "" }, to: thread.participants, cc: [] }, ctx);
  const rule = ruleFromConfirmation(parties, accountId, ctx);
  if (rule) await db.insert(t.emailMatchRules).values({ userId: user.id, kind: rule.kind, pattern: rule.pattern, accountId: rule.accountId, learned: true }).onConflictDoNothing();

  await recordContact(db, accountId, thread.lastMessageAt, thread.participants.map((p) => p.address));
  const queue = await getJobSender();
  await queue.send(memorySyncJob, { accountId }, { singletonKey: accountId, startAfterSeconds: 10 });
  await queue.send(advisorRefreshJob, { accountId }, { singletonKey: accountId, startAfterSeconds: 60 });
  revalidatePath("/inbox");
}

/** Not an account email: delete it (it shouldn't be stored), and optionally ignore the sender's domain from now on. */
export async function rejectThread(form: FormData) {
  const user = await requireUser("/inbox");
  const thread = await ownedThread(user.id, str(form, "threadId"));
  const db = getDb();
  if (form.get("ignoreDomain") === "on") {
    const from = thread.participants.find((p) => p.role === "from");
    const domain = from ? domainOf(from.address) : "";
    if (domain.length >= 3) await db.insert(t.emailMatchRules).values({ userId: user.id, kind: "ignore", pattern: domain, learned: true }).onConflictDoNothing();
  }
  // Keep a tombstone so the same thread isn't re-matched on the next sync.
  await db.delete(t.emailSummaries).where(eq(t.emailSummaries.threadId, thread.id));
  await db
    .update(t.emailThreads)
    .set({ accountId: null, matchStatus: "rejected", matchMethod: null, matchConfidence: null, matchReason: "Rejected by you", classification: null, participants: [], subject: "(removed)", candidateAccountIds: [] })
    .where(eq(t.emailThreads.id, thread.id));
  revalidatePath("/inbox");
}

export async function setStoreBodies(form: FormData) {
  const user = await requireUser("/inbox");
  await getDb().update(t.users).set({ storeEmailBodies: form.get("storeEmailBodies") === "on" }).where(eq(t.users.id, user.id));
  revalidatePath("/inbox");
}

export async function addPartnerDomain(form: FormData) {
  const user = await requireUser("/inbox");
  const domain = z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)
    .parse(str(form, "domain"));
  await getDb().insert(t.emailMatchRules).values({ userId: user.id, kind: "partner", pattern: domain }).onConflictDoNothing();
  revalidatePath("/inbox");
}
