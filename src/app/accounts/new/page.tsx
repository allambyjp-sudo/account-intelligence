import { requireUser } from "@/lib/auth/current-user";
import { startIntake } from "../../actions/accounts";
import { Card } from "../../components";

export default async function NewAccountPage() {
  await requireUser("/accounts/new");
  return (
    <div className="mx-auto max-w-lg">
      <h1 className="mb-1 text-xl font-semibold tracking-tight text-slate-900">Add an account</h1>
      <p className="mb-4 text-sm text-slate-600">Type the company's name. We'll find it in the business registers and the ASX list, and you pick the right one.</p>
      <Card>
        <form action={startIntake} className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Company name</span>
            <input name="query" required minLength={2} maxLength={200} autoFocus placeholder="e.g. Bellbird Logistics" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <fieldset>
            <legend className="text-sm font-medium text-slate-700">Where</legend>
            <div className="mt-1 flex gap-4 text-sm text-slate-700">
              {[
                ["ANY", "Australia and New Zealand"],
                ["AU", "Australia"],
                ["NZ", "New Zealand"],
              ].map(([v, label]) => (
                <label key={v} className="flex items-center gap-1.5">
                  <input type="radio" name="country" value={v} defaultChecked={v === "ANY"} /> {label}
                </label>
              ))}
            </div>
          </fieldset>
          <button className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Find it</button>
        </form>
      </Card>
    </div>
  );
}
