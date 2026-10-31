import { and, eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import { completeIntake } from "../../actions/accounts";
import { AutoRefresh } from "../../auto-refresh";
import { Badge, Card, Empty } from "../../components";

const UUID = /^[0-9a-f-]{36}$/i;
/** Registers shout ("BELLBIRD LOGISTICS PTY LTD"); suggest a readable account name instead. */
const titleCase = (s: string) =>
  s === s.toUpperCase()
    ? s
        .toLowerCase()
        .split(" ")
        .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
        .join(" ")
    : s;
const displayName = (legal: string) => titleCase(legal).replace(/\s+(Pty\.?\s*)?(Ltd|Limited)\.?$/i, "").trim();

export default async function IntakePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser(`/intake/${id}`);
  if (!UUID.test(id)) notFound();
  const [req] = await getDb()
    .select()
    .from(t.intakeRequests)
    .where(and(eq(t.intakeRequests.id, id), eq(t.intakeRequests.userId, user.id)))
    .limit(1);
  if (!req) notFound();
  if (req.status === "completed" && req.accountId) redirect(`/accounts/${req.accountId}`);

  if (req.status === "resolving") {
    return (
      <div className="mx-auto max-w-lg">
        <AutoRefresh seconds={2} />
        <Card>
          <p className="text-sm text-slate-700">
            Searching the registers for <strong>{req.query}</strong>…
          </p>
          <p className="mt-1 text-xs text-slate-500">This runs in the background worker. If nothing happens, check that the worker is running.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-1 text-xl font-semibold tracking-tight text-slate-900">Which {req.query}?</h1>
      <p className="mb-4 text-sm text-slate-600">Pick the legal entity. Research starts as soon as you confirm.</p>
      {req.notes.length > 0 && (
        <ul className="mb-4 space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {req.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <form action={completeIntake} className="space-y-4">
        <input type="hidden" name="intakeId" value={req.id} />
        <Card title="Matches">
          {req.candidates.length === 0 && <Empty>No registry matches. Enter the details by hand below.</Empty>}
          <ul className="space-y-2">
            {req.candidates.map((c, i) => (
              <li key={c.key}>
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 px-3 py-2 hover:border-brand-600/40">
                  <input type="radio" name="candidateKey" value={c.key} defaultChecked={i === 0} className="mt-1" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium text-slate-900">{c.legalName}</span>
                      {c.ticker && <Badge className="bg-brand-50 text-brand-700 ring-brand-600/20">{`${c.exchange}:${c.ticker}`}</Badge>}
                      {c.status && c.status !== "Current" && c.status !== "Registered" && <Badge className="bg-red-50 text-red-800 ring-red-600/20">{c.status}</Badge>}
                    </span>
                    <span className="block text-xs text-slate-500">
                      {[c.abn && `ABN ${c.abn}`, c.nzbn && `NZBN ${c.nzbn}`, c.entityType, c.industry, [c.state, c.postcode].filter(Boolean).join(" ")].filter(Boolean).join(" · ")}
                    </span>
                    <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-slate-500 underline">
                      Check the record
                    </a>
                  </span>
                </label>
              </li>
            ))}
            <li>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-dashed border-slate-300 px-3 py-2">
                <input type="radio" name="candidateKey" value="manual" defaultChecked={req.candidates.length === 0} className="mt-1" />
                <span className="flex-1 space-y-2 text-sm">
                  <span className="block font-medium text-slate-900">Enter it by hand</span>
                  <span className="grid gap-2 sm:grid-cols-2">
                    <input name="legalName" placeholder="Legal name" className="rounded-md border border-slate-300 px-2 py-1 text-sm" />
                    <select name="country" defaultValue={req.country === "NZ" ? "NZ" : "AU"} className="rounded-md border border-slate-300 px-2 py-1 text-sm">
                      <option value="AU">Australia</option>
                      <option value="NZ">New Zealand</option>
                    </select>
                    <input name="abn" placeholder="ABN (11 digits)" className="rounded-md border border-slate-300 px-2 py-1 text-sm" />
                    <input name="nzbn" placeholder="NZBN (13 digits)" className="rounded-md border border-slate-300 px-2 py-1 text-sm" />
                    <select name="exchange" className="rounded-md border border-slate-300 px-2 py-1 text-sm">
                      <option value="ASX">ASX</option>
                      <option value="NZX">NZX</option>
                    </select>
                    <input name="ticker" placeholder="Ticker, if listed" className="rounded-md border border-slate-300 px-2 py-1 text-sm" />
                  </span>
                  <span className="block text-xs text-slate-500">Hand-entered details show as Unconfirmed until research finds a source.</span>
                </span>
              </label>
            </li>
          </ul>
        </Card>
        <Card title="Account details">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block sm:col-span-2">
              <span className="text-sm text-slate-700">Account name</span>
              <input name="accountName" required defaultValue={req.candidates[0] ? displayName(req.candidates[0].legalName) : req.query} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
            <label className="block">
              <span className="text-sm text-slate-700">Website</span>
              <input name="websiteUrl" type="url" placeholder="https://" className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
            <label className="block">
              <span className="text-sm text-slate-700">Careers page (optional)</span>
              <input name="careersUrl" type="url" placeholder="https://" className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" name="isKeyAccount" /> Key account
            </label>
          </div>
        </Card>
        <button className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Create account and start research</button>
      </form>
    </div>
  );
}
