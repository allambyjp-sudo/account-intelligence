import { redirect } from "next/navigation";
import { readAuthConfig, safeReturnTo } from "@/lib/auth/config";
import { getCurrentUser } from "@/lib/auth/current-user";
import { Card } from "../components";

const ERRORS: Record<string, string> = {
  entra_not_configured: "Microsoft sign-in isn't set up yet. See docs/entra-sign-in-setup.md.",
  entra_declined: "Microsoft sign-in was cancelled or declined.",
  sign_in_failed: "Sign-in didn't complete. Please try again.",
};

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.returnTo);
  if (await getCurrentUser()) redirect(returnTo);
  const cfg = readAuthConfig();
  const error = params.error ? (ERRORS[params.error] ?? ERRORS.sign_in_failed) : null;

  return (
    <div className="mx-auto mt-12 max-w-sm">
      <Card>
        <h1 className="text-lg font-semibold text-slate-900">Sign in</h1>
        <p className="mt-1 text-sm text-slate-600">Use your work Microsoft account.</p>
        {params.signedOut && <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">You've signed out.</p>}
        {error && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="mt-5 space-y-3">
          {cfg.entra ? (
            <a
              href={`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`}
              className="block rounded-lg bg-brand-600 px-4 py-2 text-center text-sm font-medium text-white hover:bg-brand-700"
            >
              Sign in with Microsoft
            </a>
          ) : (
            <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">Microsoft sign-in isn't configured on this server yet.</p>
          )}
          {cfg.devBypass && (
            <form action="/api/auth/dev" method="post">
              <input type="hidden" name="returnTo" value={returnTo} />
              <button className="w-full rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
                Development sign-in
              </button>
              <p className="mt-1 text-center text-[11px] text-slate-500">Local only. Refused in production.</p>
            </form>
          )}
        </div>
      </Card>
    </div>
  );
}
