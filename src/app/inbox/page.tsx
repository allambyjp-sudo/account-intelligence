import { eq } from "drizzle-orm";
import Link from "next/link";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import { loadInbox } from "@/lib/email/inbox";
import { realMailboxPolicy } from "@/lib/email/policy";
import { formatDateTime, humanise, timeAgo } from "@/lib/format";
import { addPartnerDomain, confirmThread, connectSynthetic, disconnectMailbox, rejectThread, setStoreBodies, syncNow } from "../actions/email";
import { AutoRefresh } from "../auto-refresh";
import { Badge, Card, Empty } from "../components";

const ERRORS: Record<string, string> = {
  not_approved: "Real mailboxes can't be connected yet. See the reasons in the Mailboxes panel.",
  entra_not_configured: "Microsoft sign-in isn't configured, so Outlook can't be connected.",
  gmail_not_configured: "Gmail isn't configured (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI).",
  connect_failed: "The mailbox couldn't be connected. Try again.",
};

const CLASS_STYLE: Record<string, string> = {
  needs_reply: "bg-red-50 text-red-800 ring-red-600/20",
  deadline_mentioned: "bg-amber-50 text-amber-800 ring-amber-600/20",
  quote_or_renewal: "bg-brand-50 text-brand-700 ring-brand-600/20",
  waiting_on_them: "bg-slate-100 text-slate-700 ring-slate-500/20",
  info_only: "bg-slate-100 text-slate-500 ring-slate-500/20",
};

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ error?: string; syncing?: string; connected?: string }> }) {
  const params = await searchParams;
  const user = await requireUser("/inbox");
  const db = getDb();
  const inbox = await loadInbox(db, user.id);
  const [me] = await db.select().from(t.users).where(eq(t.users.id, user.id));
  const policy = realMailboxPolicy();
  const names = new Map(inbox.accounts.map((a) => [a.id, a.name]));
  const busy = Boolean(params.syncing || params.connected);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      {busy && <AutoRefresh seconds={4} />}
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Seller inbox</h1>
          <p className="text-sm text-slate-600">Email across your accounts, most urgent first. Only mail that belongs to an account is kept.</p>
        </div>
        {params.error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{ERRORS[params.error] ?? "Something went wrong."}</p>}

        <Card title={`Confirm (${inbox.confirm.length})`}>
          {inbox.confirm.length === 0 ? (
            <Empty>Nothing to confirm.</Empty>
          ) : (
            <ul className="divide-y divide-slate-100">
              {inbox.confirm.map(({ thread, summary }) => (
                <li key={thread.id} className="py-3">
                  <div className="text-sm font-medium text-slate-900">{thread.subject}</div>
                  <div className="text-xs text-slate-500">
                    {thread.participants.find((p) => p.role === "from")?.address} · {formatDateTime(thread.lastMessageAt)} · {thread.matchReason}
                    {thread.matchConfidence && ` (${Math.round(Number(thread.matchConfidence) * 100)}%)`}
                  </div>
                  {summary && <p className="mt-1 text-sm text-slate-700">{summary.summary}</p>}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <form action={confirmThread} className="flex items-center gap-2">
                      <input type="hidden" name="threadId" value={thread.id} />
                      <select name="accountId" defaultValue={thread.accountId ?? undefined} className="rounded-md border border-slate-300 px-2 py-1 text-sm">
                        {[...new Set([...thread.candidateAccountIds, ...inbox.accounts.map((a) => a.id)])].map((id) => (
                          <option key={id} value={id}>
                            {names.get(id)}
                            {thread.candidateAccountIds.includes(id) ? " (suggested)" : ""}
                          </option>
                        ))}
                      </select>
                      <button className="rounded-md bg-brand-600 px-2.5 py-1 text-sm font-medium text-white hover:bg-brand-700">Confirm</button>
                    </form>
                    <form action={rejectThread} className="flex items-center gap-2 text-xs text-slate-600">
                      <input type="hidden" name="threadId" value={thread.id} />
                      <label className="flex items-center gap-1">
                        <input type="checkbox" name="ignoreDomain" /> ignore this sender's domain
                      </label>
                      <button className="rounded-md border border-slate-300 px-2.5 py-1 text-sm text-slate-700 hover:bg-slate-50">Not an account email</button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Priority">
          {inbox.priority.length === 0 ? (
            <Empty>No account email yet. Connect a mailbox on the right.</Empty>
          ) : (
            <ul className="divide-y divide-slate-100">
              {inbox.priority.map(({ thread, accountName, summary, why }) => (
                <li key={thread.id} className="py-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {thread.classification && <Badge className={CLASS_STYLE[thread.classification] ?? CLASS_STYLE.info_only!}>{humanise(thread.classification)}</Badge>}
                    <Link href={`/accounts/${thread.accountId}`} className="text-xs font-medium text-brand-700 hover:underline">
                      {accountName}
                    </Link>
                    <span className="text-xs text-slate-500">· {timeAgo(thread.lastMessageAt)} · {why}</span>
                  </div>
                  <div className="text-sm font-medium text-slate-900">{thread.subject}</div>
                  {summary && <p className="text-sm text-slate-600">{summary.summary}</p>}
                  {summary && summary.deadlines.length > 0 && <p className="text-xs text-amber-800">Deadline: {summary.deadlines.map((d) => `${d.what} (${d.date})`).join("; ")}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <aside className="space-y-4">
        <Card title="Quiet customers">
          {inbox.quiet.length === 0 ? (
            <Empty>No key account has gone quiet.</Empty>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {inbox.quiet.map((a) => (
                <li key={a.id}>
                  <Link href={`/accounts/${a.accountId}`} className="text-brand-700 hover:underline">
                    {a.title}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Mailboxes">
          <ul className="space-y-2 text-sm">
            {inbox.connections.map((c) => (
              <li key={c.id} className="rounded-md border border-slate-200 px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-slate-900">{c.provider === "graph" ? "Outlook" : c.provider === "gmail" ? "Gmail" : "Synthetic"}</span>
                  <Badge className={c.status === "active" ? "bg-emerald-50 text-emerald-800 ring-emerald-600/20" : c.status === "error" ? "bg-red-50 text-red-800 ring-red-600/20" : "bg-slate-100 text-slate-600 ring-slate-500/20"}>
                    {c.status}
                  </Badge>
                </div>
                <div className="text-xs text-slate-500">
                  {c.mailbox} · synced {timeAgo(c.lastSyncedAt)}
                </div>
                {c.lastError && <div className="text-xs text-red-700">{c.lastError}</div>}
                {c.status !== "disconnected" && (
                  <div className="mt-1 flex gap-3 text-xs">
                    <form action={syncNow}>
                      <input type="hidden" name="connectionId" value={c.id} />
                      <button className="text-brand-700 hover:underline">Sync now</button>
                    </form>
                    <form action={disconnectMailbox}>
                      <input type="hidden" name="connectionId" value={c.id} />
                      <button className="text-slate-500 hover:underline">Disconnect</button>
                    </form>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-3 space-y-2">
            {!inbox.connections.some((c) => c.provider === "synthetic" && c.status === "active") && (
              <form action={connectSynthetic}>
                <button className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">Connect the synthetic test mailbox</button>
              </form>
            )}
            {policy.allowed ? (
              <div className="flex gap-2">
                <a href="/api/connect/graph/start" className="flex-1 rounded-lg bg-brand-600 px-3 py-1.5 text-center text-sm font-medium text-white hover:bg-brand-700">
                  Connect Outlook
                </a>
                <a href="/api/connect/gmail/start" className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-center text-sm text-slate-700 hover:bg-slate-50">
                  Connect Gmail
                </a>
              </div>
            ) : (
              <div className="rounded-md bg-slate-50 px-2 py-1.5 text-xs text-slate-600">
                <p className="font-medium text-slate-700">Real mailboxes are off</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {policy.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>
        <Card title="Privacy">
          <form action={setStoreBodies} className="space-y-2 text-sm text-slate-700">
            <label className="flex items-start gap-2">
              <input type="checkbox" name="storeEmailBodies" defaultChecked={me?.storeEmailBodies} className="mt-1" />
              <span>Keep full email bodies. Off by default: only summaries and metadata are stored.</span>
            </label>
            <button className="rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50">Save</button>
          </form>
          <p className="mt-2 text-xs text-slate-500">Exclude a sensitive account in its settings; its email is never stored.</p>
        </Card>
        <Card title="Partners and distributors">
          <p className="mb-2 text-xs text-slate-500">Their email is matched by the account it names, and always confirmed by you.</p>
          <form action={addPartnerDomain} className="flex gap-2">
            <input name="domain" placeholder="distributor.example" className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm" />
            <button className="rounded-md border border-slate-300 px-2.5 py-1 text-sm hover:bg-slate-50">Add</button>
          </form>
        </Card>
      </aside>
    </div>
  );
}
