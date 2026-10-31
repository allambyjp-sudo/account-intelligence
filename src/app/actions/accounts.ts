"use server";

import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import { confirmIntake, confirmSchema } from "@/lib/intake/intake";
import { researchAccountJob, resolveIntakeJob } from "@/lib/jobs/research";
import { getJobSender } from "@/lib/jobs/sender";
import { createResearchRun } from "@/lib/research/run";

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

/** Every action re-checks ownership: server actions are public endpoints. */
async function ownedAccount(userId: string, accountId: string) {
  const [account] = await getDb()
    .select()
    .from(t.accounts)
    .where(and(eq(t.accounts.id, accountId), eq(t.accounts.ownerUserId, userId)))
    .limit(1);
  if (!account) throw new Error("Account not found");
  return account;
}

export async function startIntake(form: FormData) {
  const user = await requireUser("/accounts/new");
  const input = z.object({ query: z.string().trim().min(2).max(200), country: z.enum(["AU", "NZ", "ANY"]) }).parse({ query: str(form, "query"), country: str(form, "country") ?? "ANY" });
  const [req] = await getDb().insert(t.intakeRequests).values({ userId: user.id, ...input }).returning();
  await (await getJobSender()).send(resolveIntakeJob, { intakeId: req!.id });
  redirect(`/intake/${req!.id}`);
}

export async function completeIntake(form: FormData) {
  const user = await requireUser("/accounts/new");
  const manual = str(form, "candidateKey") === "manual";
  const input = confirmSchema.parse({
    intakeId: str(form, "intakeId"),
    candidateKey: manual ? undefined : str(form, "candidateKey"),
    accountName: str(form, "accountName"),
    legalName: manual ? str(form, "legalName") : undefined,
    country: manual ? str(form, "country") : undefined,
    abn: manual ? str(form, "abn")?.replace(/\s/g, "") : undefined,
    nzbn: manual ? str(form, "nzbn")?.replace(/\s/g, "") : undefined,
    exchange: manual && str(form, "ticker") ? str(form, "exchange") : undefined,
    ticker: manual ? str(form, "ticker")?.toUpperCase() : undefined,
    websiteUrl: str(form, "websiteUrl"),
    careersUrl: str(form, "careersUrl"),
    isKeyAccount: form.get("isKeyAccount") === "on",
  });
  const { accountId, created } = await confirmIntake(getDb(), user.id, input);
  if (created) await queueResearch(user.id, accountId);
  redirect(`/accounts/${accountId}`);
}

async function queueResearch(userId: string, accountId: string) {
  const db = getDb();
  // One run at a time per account: a queued or running run in the last hour blocks another.
  const [active] = await db
    .select({ id: t.researchRuns.id })
    .from(t.researchRuns)
    .where(and(eq(t.researchRuns.accountId, accountId), inArray(t.researchRuns.status, ["queued", "running"]), gt(t.researchRuns.createdAt, new Date(Date.now() - 3_600_000))))
    .orderBy(desc(t.researchRuns.createdAt))
    .limit(1);
  if (active) return active.id;
  const run = await createResearchRun(db, accountId, userId);
  await (await getJobSender()).send(researchAccountJob, { runId: run.id });
  return run.id;
}

export async function rerunResearch(form: FormData) {
  const user = await requireUser();
  const account = await ownedAccount(user.id, z.uuid().parse(str(form, "accountId")));
  await queueResearch(user.id, account.id);
  revalidatePath(`/accounts/${account.id}`);
  redirect(`/accounts/${account.id}/brief`);
}

const urlOrEmpty = z.union([z.literal(""), z.url({ protocol: /^https?$/ })]).optional();

export async function updateAccountSettings(form: FormData) {
  const user = await requireUser();
  const account = await ownedAccount(user.id, z.uuid().parse(str(form, "accountId")));
  const lines = (k: string) =>
    (str(form, k) ?? "")
      .split(/\r?\n|,/)
      .map((s) => s.trim())
      .filter(Boolean);
  const input = z
    .object({
      name: z.string().trim().min(2).max(120),
      websiteUrl: urlOrEmpty,
      careersUrl: urlOrEmpty,
      reportUrls: z.array(z.url({ protocol: /^https?$/ })).max(5),
      newsTerms: z.array(z.string().max(60)).max(10),
      isKeyAccount: z.boolean(),
      quietAfterDays: z.coerce.number().int().min(1).max(365),
      status: z.enum(["prospect", "active", "dormant"]),
      emailExcluded: z.boolean(),
      emailExcludedReason: z.string().max(200).optional(),
    })
    .parse({
      name: str(form, "name"),
      websiteUrl: str(form, "websiteUrl") ?? "",
      careersUrl: str(form, "careersUrl") ?? "",
      reportUrls: lines("reportUrls"),
      newsTerms: lines("newsTerms"),
      isKeyAccount: form.get("isKeyAccount") === "on",
      quietAfterDays: str(form, "quietAfterDays") ?? "30",
      status: str(form, "status") ?? "prospect",
      emailExcluded: form.get("emailExcluded") === "on",
      emailExcludedReason: str(form, "emailExcludedReason"),
    });
  await getDb()
    .update(t.accounts)
    .set({
      name: input.name,
      websiteUrl: input.websiteUrl || null,
      careersUrl: input.careersUrl || null,
      reportUrls: input.reportUrls,
      newsTerms: input.newsTerms,
      isKeyAccount: input.isKeyAccount,
      quietAfterDays: input.quietAfterDays,
      status: input.status,
      emailExcluded: input.emailExcluded,
      emailExcludedReason: input.emailExcluded ? (input.emailExcludedReason ?? "Excluded by the seller") : null,
    })
    .where(eq(t.accounts.id, account.id));
  revalidatePath(`/accounts/${account.id}`);
  redirect(`/accounts/${account.id}?saved=1`);
}

export async function deleteAccount(form: FormData) {
  const user = await requireUser();
  const account = await ownedAccount(user.id, z.uuid().parse(str(form, "accountId")));
  if (str(form, "confirmName") !== account.name) redirect(`/accounts/${account.id}/settings?error=confirm`);
  // Cascades to entities, stakeholders, signals, notes, meetings, email and memory for this account.
  await getDb().delete(t.accounts).where(eq(t.accounts.id, account.id));
  redirect("/?deleted=1");
}
