import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import { deleteAccount, updateAccountSettings } from "../../../actions/accounts";
import { Card } from "../../../components";

const UUID = /^[0-9a-f-]{36}$/i;
const input = "mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm";

export default async function AccountSettingsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const { error } = await searchParams;
  const user = await requireUser(`/accounts/${id}/settings`);
  if (!UUID.test(id)) notFound();
  const [a] = await getDb().select().from(t.accounts).where(and(eq(t.accounts.id, id), eq(t.accounts.ownerUserId, user.id))).limit(1);
  if (!a) notFound();

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <Link href={`/accounts/${id}`} className="text-sm text-brand-700 hover:underline">
          ← {a.name}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Account settings</h1>
      </div>
      <form action={updateAccountSettings} className="space-y-4">
        <input type="hidden" name="accountId" value={a.id} />
        <Card title="Account">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block sm:col-span-2">
              <span className="text-sm text-slate-700">Name</span>
              <input name="name" required defaultValue={a.name} className={input} />
            </label>
            <label className="block">
              <span className="text-sm text-slate-700">Status</span>
              <select name="status" defaultValue={a.status} className={input}>
                <option value="prospect">Prospect</option>
                <option value="active">Active</option>
                <option value="dormant">Dormant</option>
              </select>
            </label>
            <label className="block">
              <span className="text-sm text-slate-700">Quiet-customer alert after (days)</span>
              <input name="quietAfterDays" type="number" min={1} max={365} defaultValue={a.quietAfterDays} className={input} />
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" name="isKeyAccount" defaultChecked={a.isKeyAccount} /> Key account
            </label>
          </div>
        </Card>
        <Card title="Where to look">
          <div className="space-y-3">
            <label className="block">
              <span className="text-sm text-slate-700">Website</span>
              <input name="websiteUrl" type="url" defaultValue={a.websiteUrl ?? ""} className={input} />
            </label>
            <label className="block">
              <span className="text-sm text-slate-700">Careers page</span>
              <input name="careersUrl" type="url" defaultValue={a.careersUrl ?? ""} className={input} />
              <span className="text-xs text-slate-500">Checked daily for new technology roles.</span>
            </label>
            <label className="block">
              <span className="text-sm text-slate-700">Annual or half-year report PDFs (one per line, up to 5)</span>
              <textarea name="reportUrls" rows={3} defaultValue={a.reportUrls.join("\n")} className={input} />
            </label>
            <label className="block">
              <span className="text-sm text-slate-700">Extra news search terms (brands, former names; one per line)</span>
              <textarea name="newsTerms" rows={2} defaultValue={a.newsTerms.join("\n")} className={input} />
            </label>
          </div>
        </Card>
        <Card title="Email">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" name="emailExcluded" defaultChecked={a.emailExcluded} /> Exclude this account from email ingestion
          </label>
          <input name="emailExcludedReason" placeholder="Reason, e.g. government or health data" defaultValue={a.emailExcludedReason ?? ""} className={input} />
          <p className="mt-1 text-xs text-slate-500">Excluding deletes any email already stored against the account, and the database refuses new email for it.</p>
        </Card>
        <button className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Save</button>
      </form>

      <Card title="Delete account">
        <form action={deleteAccount} className="space-y-2">
          <input type="hidden" name="accountId" value={a.id} />
          <p className="text-sm text-slate-600">Deletes the account and everything stored with it: brief, stakeholders, signals, notes, meetings and email. This can't be undone.</p>
          {error === "confirm" && <p className="text-sm text-red-700">Type the account name exactly to confirm.</p>}
          <input name="confirmName" placeholder={`Type "${a.name}" to confirm`} className={input} />
          <button className="rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50">Delete account</button>
        </form>
      </Card>
    </div>
  );
}
