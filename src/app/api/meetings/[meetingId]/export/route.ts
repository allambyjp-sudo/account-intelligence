import { and, eq, inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import { onePagerToDocx, onePagerToPdf } from "@/lib/meetings/export";
import { buildOnePager, fileStem } from "@/lib/meetings/onepager";
import type { MeetingPrep } from "@/lib/meetings/prep";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ meetingId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorised", { status: 401 });
  const { meetingId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(meetingId)) return new NextResponse("Not found", { status: 404 });
  const format = req.nextUrl.searchParams.get("format");
  if (format !== "docx" && format !== "pdf") return new NextResponse("format must be docx or pdf", { status: 400 });

  const db = getDb();
  const [row] = await db
    .select({ m: t.meetings, a: t.accounts })
    .from(t.meetings)
    .innerJoin(t.accounts, eq(t.meetings.accountId, t.accounts.id))
    .where(and(eq(t.meetings.id, meetingId), eq(t.accounts.ownerUserId, user.id)))
    .limit(1);
  if (!row?.m.prep || !row.m.prepGeneratedAt) return new NextResponse("Not found", { status: 404 });

  const people = row.m.attendeeStakeholderIds.length ? await db.select().from(t.stakeholders).where(inArray(t.stakeholders.id, row.m.attendeeStakeholderIds)) : [];
  const onePager = buildOnePager({
    accountName: row.a.name,
    meetingTitle: row.m.title,
    scheduledFor: row.m.scheduledFor,
    attendees: [...people.map((p) => p.fullName), ...row.m.otherAttendees.map((o) => o.name)],
    prep: row.m.prep as MeetingPrep,
    generatedAt: row.m.prepGeneratedAt,
  });
  const body = format === "docx" ? await onePagerToDocx(onePager) : await onePagerToPdf(onePager);
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "content-type": format === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/pdf",
      "content-disposition": `attachment; filename="${fileStem(onePager.title)}.${format}"`,
      "cache-control": "private, no-store",
    },
  });
}
