import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto mt-16 max-w-md text-center">
      <h1 className="text-lg font-semibold text-slate-900">Not found</h1>
      <p className="mt-1 text-sm text-slate-600">That page doesn't exist, or the account isn't one of yours.</p>
      <Link href="/" className="mt-4 inline-block text-sm text-brand-700 underline">
        Back to your portfolio
      </Link>
    </div>
  );
}
