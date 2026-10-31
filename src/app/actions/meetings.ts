"use server";

import { and, eq, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import { meetingPrepJob } from "@/lib/jobs/meetings";
import { getJobSender } from "@/lib/jobs/sender";

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

export async function createMeeting(form: FormData) {
  const user = await requireUser();
  const accountId = z.uuid().parse(str(form, "accountId"));
  const db = getDb();
  const [account] = await db.select({ id: t.accounts.id }).from(t.accounts).where(and(eq(t.accounts.id, accountId), eq(t.accounts.ownerUserId, user.id))).limit(1);
  if (!account) throw new Error("Account not found");

  const picked = form.getAll("attendee").filter((v): v is string => typeof v === "string");
  const valid = picked.length
    ? (await db.select({ id: t.stakeholders.id }).from(t.stakeholders).where(and(eq(t.stakeholders.accountId, accountId), inArray(t.stakeholders.id, picked)))).map((r) => r.id)
    : [];
  const others = (str(form, "otherAttendees") ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((l) => {
      const [name, ...role] = l.split(",");
      return { name: name!.trim(), ...(role.length ? { role: role.join(",").trim() } : {}) };
    });
  const input = z
    .object({ title: z.string().trim().min(2).max(200), scheduledFor: z.string().optional() })
    .parse({ title: str(form, "title") ?? "Account meeting", scheduledFor: str(form, "scheduledFor") });
  // datetime-local has no zone; the seller means Melbourne time.
  const scheduledFor = input.scheduledFor ? new Date(`${input.scheduledFor}:00${melbourneOffset(input.scheduledFor)}`) : null;

  const [meeting] = await db
    .insert(t.meetings)
    .values({ accountId, createdBy: user.id, title: input.title, scheduledFor, attendeeStakeholderIds: valid, otherAttendees: others, prepRequestedAt: new Date() })
    .returning();
  await (await getJobSender()).send(meetingPrepJob, { meetingId: meeting!.id });
  redirect(`/accounts/${accountId}/meetings/${meeting!.id}`);
}

export async function regeneratePrep(form: FormData) {
  const user = await requireUser();
  const meetingId = z.uuid().parse(str(form, "meetingId"));
  const db = getDb();
  const [row] = await db
    .select({ m: t.meetings })
    .from(t.meetings)
    .innerJoin(t.accounts, eq(t.meetings.accountId, t.accounts.id))
    .where(and(eq(t.meetings.id, meetingId), eq(t.accounts.ownerUserId, user.id)))
    .limit(1);
  if (!row) throw new Error("Meeting not found");
  await db.update(t.meetings).set({ prep: null, prepGeneratedAt: null, prepError: null, promptId: null, promptVersion: null, model: null, prepRequestedAt: new Date() }).where(eq(t.meetings.id, meetingId));
  await (await getJobSender()).send(meetingPrepJob, { meetingId });
  redirect(`/accounts/${row.m.accountId}/meetings/${meetingId}`);
}

/** "+10:00" or "+11:00" for a local Melbourne date-time, from the platform's time zone data. */
function melbourneOffset(local: string): string {
  const guess = new Date(`${local}:00Z`);
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", timeZoneName: "longOffset" }).formatToParts(guess);
  const off = parts.find((p) => p.type === "timeZoneName")?.value.replace("GMT", "") ?? "+10:00";
  return off || "+00:00";
}
