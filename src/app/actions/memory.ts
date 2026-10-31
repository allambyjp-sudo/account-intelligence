"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import { NOTE_KIND } from "@/lib/domain/enums";
import { advisorRefreshJob, memorySyncJob } from "@/lib/jobs/advisor";
import { getJobSender } from "@/lib/jobs/sender";

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

async function ownedAccountId(userId: string, accountId: unknown) {
  const id = z.uuid().parse(accountId);
  const [a] = await getDb().select({ id: t.accounts.id, lastContactAt: t.accounts.lastContactAt }).from(t.accounts).where(and(eq(t.accounts.id, id), eq(t.accounts.ownerUserId, userId))).limit(1);
  if (!a) throw new Error("Account not found");
  return a;
}

/** Contact-bearing note kinds move "last contact" forward, which drives quiet-customer alerts. */
const CONTACT_KINDS = new Set(["meeting", "outcome"]);

export async function addNote(form: FormData) {
  const user = await requireUser();
  const account = await ownedAccountId(user.id, str(form, "accountId"));
  const input = z
    .object({
      kind: z.enum(NOTE_KIND),
      body: z.string().trim().min(1).max(10_000),
      occurredOn: z.iso.date().optional(),
      dueOn: z.iso.date().optional(),
      inputMethod: z.enum(["typed", "voice"]).default("typed"),
    })
    .parse({ kind: str(form, "kind") ?? "note", body: str(form, "body"), occurredOn: str(form, "occurredOn"), dueOn: str(form, "dueOn"), inputMethod: str(form, "inputMethod") ?? "typed" });
  const occurredAt = input.occurredOn ? new Date(`${input.occurredOn}T09:00:00+10:00`) : new Date();
  const db = getDb();
  await db.insert(t.notes).values({ accountId: account.id, authorUserId: user.id, kind: input.kind, body: input.body, occurredAt, dueOn: input.dueOn ?? null, inputMethod: input.inputMethod });
  if (CONTACT_KINDS.has(input.kind) && (!account.lastContactAt || account.lastContactAt < occurredAt)) {
    await db.update(t.accounts).set({ lastContactAt: occurredAt }).where(eq(t.accounts.id, account.id));
  }
  const queue = await getJobSender();
  await queue.send(memorySyncJob, { accountId: account.id }, { singletonKey: account.id, startAfterSeconds: 5 });
  // Notes about outcomes, meetings and next steps change what the advisor should say.
  if (input.kind !== "note") await queue.send(advisorRefreshJob, { accountId: account.id }, { singletonKey: account.id, startAfterSeconds: 60 });
  revalidatePath(`/accounts/${account.id}`);
}

export async function completeNote(form: FormData) {
  const user = await requireUser();
  const account = await ownedAccountId(user.id, str(form, "accountId"));
  const noteId = z.uuid().parse(str(form, "noteId"));
  await getDb().update(t.notes).set({ completedAt: new Date() }).where(and(eq(t.notes.id, noteId), eq(t.notes.accountId, account.id)));
  revalidatePath(`/accounts/${account.id}`);
}

export async function setRecommendationStatus(form: FormData) {
  const user = await requireUser();
  const account = await ownedAccountId(user.id, str(form, "accountId"));
  const id = z.uuid().parse(str(form, "recommendationId"));
  const status = z.enum(["done", "dismissed"]).parse(str(form, "status"));
  await getDb().update(t.recommendations).set({ status }).where(and(eq(t.recommendations.id, id), eq(t.recommendations.accountId, account.id)));
  revalidatePath(`/accounts/${account.id}`);
}

export async function refreshAdvice(form: FormData) {
  const user = await requireUser();
  const account = await ownedAccountId(user.id, str(form, "accountId"));
  await (await getJobSender()).send(advisorRefreshJob, { accountId: account.id, force: true }, { singletonKey: account.id });
  redirect(`/accounts/${account.id}?advising=1`);
}
