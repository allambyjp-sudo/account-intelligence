import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/current-user";
import "./globals.css";

export const metadata: Metadata = {
  title: "Account Intelligence",
  description: "Cited ANZ account briefs, live signals, a sales advisor, account memory and meeting prep.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  return (
    <html lang="en-AU">
      <body className="min-h-screen font-sans antialiased">
        <div className="border-b border-violet-200 bg-violet-50 px-4 py-1.5 text-center text-xs text-violet-900">
          Development build: <strong>fictional and public data only</strong>. No real customer data until the model layer runs
          through Conver.
        </div>
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link href="/" className="text-base font-semibold tracking-tight text-brand-900">
              Account Intelligence
            </Link>
            {user && (
              <nav className="flex gap-1 text-sm">
                {[
                  ["/", "Portfolio"],
                  ["/accounts/new", "Add account"],
                  ["/sources", "Sources"],
                ].map(([href, label]) => (
                  <Link key={href} href={href!} className="rounded-md px-2.5 py-1 text-slate-600 hover:bg-slate-100 hover:text-slate-900">
                    {label}
                  </Link>
                ))}
              </nav>
            )}
            {user && (
              <div className="ml-auto flex items-center gap-3 text-sm text-slate-600">
                <span>{user.displayName}</span>
                <form action="/api/auth/logout" method="post">
                  <button className="rounded-md px-2.5 py-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900">Sign out</button>
                </form>
              </div>
            )}
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
