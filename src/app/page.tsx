import Link from "next/link";
import { loadPortfolio } from "@/lib/accounts/queries";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db/client";
import { timeAgo } from "@/lib/format";
import { Badge, Card, Empty, FictionalBadge } from "./components";

export default async function PortfolioPage() {
  const user = await requireUser("/");
  const rows = await loadPortfolio(getDb(), user.id);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div>
        <div className="mb-4 flex items-end justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">Portfolio</h1>
            <p className="text-sm text-slate-600">Your accounts, most urgent first.</p>
          </div>
          <span className="rounded-lg border border-dashed border-slate-300 px-3 py-1.5 text-xs text-slate-500" title="Phase 2">
            Add account: arrives with intake in Phase 2
          </span>
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
        <Card title="Seller inbox">
          <Empty>Your cross-account email priority list arrives in Phase 6, against a test mailbox with synthetic data.</Empty>
        </Card>
      </aside>
    </div>
  );
}
