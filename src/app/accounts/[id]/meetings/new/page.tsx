import { and, asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import { createMeeting } from "../../../../actions/meetings";
import { Card } from "../../../../components";

export default async function NewMeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser(`/accounts/${id}/meetings/new`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = getDb();
  const [account] = await db.select().from(t.accounts).where(and(eq(t.accounts.id, id), eq(t.accounts.ownerUserId, user.id))).limit(1);
  if (!account) notFound();
  const people = await db.select().from(t.stakeholders).where(eq(t.stakeholders.accountId, id)).orderBy(asc(t.stakeholders.fullName));

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div>
        <Link href={`/accounts/${id}`} className="text-sm text-brand-700 hover:underline">
          ← {account.name}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Prepare for a meeting</h1>
        <p className="text-sm text-slate-600">Everything is optional. Pick who's coming for attendee profiles and history.</p>
      </div>
      <form action={createMeeting} className="space-y-4">
        <input type="hidden" name="accountId" value={id} />
        <Card>
          <div className="space-y-3">
            <label className="block">
              <span className="text-sm text-slate-700">What's the meeting?</span>
              <input name="title" placeholder="e.g. Security roadmap catch-up" className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
            <label className="block">
              <span className="text-sm text-slate-700">When (Melbourne time)</span>
              <input name="scheduledFor" type="datetime-local" className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
            <fieldset>
              <legend className="text-sm text-slate-700">Who's coming</legend>
              {people.length === 0 && <p className="text-xs text-slate-500">No stakeholders on record yet.</p>}
              <div className="mt-1 grid gap-1 sm:grid-cols-2">
                {people.map((p) => (
                  <label key={p.id} className="flex items-start gap-2 text-sm text-slate-700">
                    <input type="checkbox" name="attendee" value={p.id} className="mt-1" />
                    <span>
                      {p.fullName}
                      <span className="block text-xs text-slate-500">{p.title}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="block">
              <span className="text-sm text-slate-700">Anyone else (one per line: name, role)</span>
              <textarea name="otherAttendees" rows={2} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
          </div>
        </Card>
        <button className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Prepare</button>
      </form>
    </div>
  );
}
