import Link from "next/link";
import { loadPortfolio } from "@/lib/accounts/queries";
import { loadInbox } from "@/lib/email/inbox";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db/client";
import { timeAgo } from "@/lib/format";
import { Badge, Card, Empty, FictionalBadge } from "./components";

export default async function PortfolioPage() {
  const user = await requireUser("/");
  const rows = await loadPortfolio(getDb(), user.id);
  const inbox = await loadInbox(getDb(), user.id);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div>
        <div className="mb-4 flex items-end justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">Portfolio</h1>
            <p className="text-sm text-slate-600">Your accounts, most urgent first.</p>
          </div>
          <Link href="/accounts/new" className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">
            Add account
          </Link>
        </div>
        {rows.length === 0 ? (
          <Empty>
            No accounts yet. Run <code className="rounded bg-slate-100 px-1">npm run db:seed</code> to load the fictional demo accounts.
          </Empty>
        ) : (
          <ul className="space-y-2">
            {rows.map(({ account, primaryEntity, urgency, lastSignalAt }) => (
              <li key={account.id}>
                <Link
                  href={`/accounts/${account.id}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm hover:border-brand-600/40"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-900">{account.name}</span>
                      {account.isFictional && <FictionalBadge />}
                      {account.isKeyAccount && <Badge className="bg-brand-50 text-brand-700 ring-brand-600/20">Key account</Badge>}
                      {account.emailExcluded && <Badge className="bg-slate-100 text-slate-600 ring-slate-500/20">Email excluded</Badge>}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {[primaryEntity?.industry, primaryEntity?.ticker ? `${primaryEntity.exchange}:${primaryEntity.ticker}` : "Unlisted", primaryEntity?.country]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  <div className="text-right text-xs">
                    {urgency.reasons.length ? (
                      <div className="font-medium text-slate-800">{urgency.reasons.join(" · ")}</div>
                    ) : (
                      <div className="text-slate-500">Nothing urgent</div>
                    )}
                    <div className="text-slate-500">Last signal {timeAgo(lastSignalAt)}</div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      <aside>
        <Card
          title="Seller inbox"
          action={
            <Link href="/inbox" className="text-xs text-brand-700 hover:underline">
              Open →
            </Link>
          }
        >
          {inbox.confirm.length > 0 && (
            <Link href="/inbox" className="mb-2 block rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900">
              {inbox.confirm.length} email{inbox.confirm.length === 1 ? "" : "s"} to confirm
            </Link>
          )}
          {inbox.priority.length === 0 ? (
            <Empty>No account email yet. Connect a mailbox from the inbox.</Empty>
          ) : (
            <ul className="space-y-2">
              {inbox.priority.slice(0, 5).map(({ thread, accountName, why }) => (
                <li key={thread.id} className="text-sm">
                  <div className="text-xs text-slate-500">
                    {accountName} · {why}
                  </div>
                  <div className="text-slate-900">{thread.subject}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </aside>
    </div>
  );
}
