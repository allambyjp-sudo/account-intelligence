import type { Source } from "@/lib/db/schema";
import type { Confidence, ContactConfidence, Importance, Verification } from "@/lib/domain/enums";
import { formatDate } from "@/lib/format";

export function Badge({ className, children, title }: { className: string; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${className}`}
    >
      {children}
    </span>
  );
}

const CONFIDENCE_STYLE: Record<Confidence, string> = {
  high: "bg-emerald-50 text-emerald-800 ring-emerald-600/20",
  medium: "bg-amber-50 text-amber-800 ring-amber-600/20",
  low: "bg-slate-100 text-slate-600 ring-slate-500/20",
};

export function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  return <Badge className={CONFIDENCE_STYLE[confidence]}>{confidence[0]!.toUpperCase() + confidence.slice(1)} confidence</Badge>;
}

/** The brief's rule: anything that can't be traced to a source is labelled Unconfirmed. */
export function VerificationBadge({ verification }: { verification: Verification }) {
  if (verification === "verified") return null;
  return (
    <Badge className="bg-orange-50 text-orange-800 ring-orange-600/30" title="No source on record yet">
      Unconfirmed
    </Badge>
  );
}

const CONTACT_LABEL: Record<ContactConfidence, { label: string; style: string; title: string }> = {
  published: { label: "Published", style: "bg-emerald-50 text-emerald-800 ring-emerald-600/20", title: "Appears on a public page we cite" },
  verified_pattern: {
    label: "Verified pattern",
    style: "bg-sky-50 text-sky-800 ring-sky-600/20",
    title: "Follows an address pattern confirmed by two or more published addresses",
  },
  inferred: { label: "Inferred", style: "bg-slate-100 text-slate-600 ring-slate-500/20", title: "A best guess. Confirm before using." },
};

export function ContactConfidenceBadge({ confidence }: { confidence: ContactConfidence }) {
  const c = CONTACT_LABEL[confidence];
  return (
    <Badge className={c.style} title={c.title}>
      {c.label}
    </Badge>
  );
}

const IMPORTANCE_STYLE: Record<Importance, string> = {
  high: "bg-red-50 text-red-800 ring-red-600/20",
  medium: "bg-amber-50 text-amber-800 ring-amber-600/20",
  low: "bg-slate-100 text-slate-600 ring-slate-500/20",
};

export function ImportanceBadge({ importance }: { importance: Importance }) {
  return <Badge className={IMPORTANCE_STYLE[importance]}>{importance[0]!.toUpperCase() + importance.slice(1)}</Badge>;
}

export function FictionalBadge() {
  return <Badge className="bg-violet-50 text-violet-800 ring-violet-600/20">Fictional</Badge>;
}

/** A citation: where a claim came from and when we read it. */
export function SourceLink({ source, retrievedAt }: { source: Source | undefined; retrievedAt?: Date | null }) {
  if (!source) return null;
  const host = new URL(source.url).host.replace(/^www\./, "");
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[11px] text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-brand-700"
      title={source.title ?? source.url}
    >
      {source.publisher ?? host} · retrieved {formatDate(retrievedAt ?? source.retrievedAt)}
    </a>
  );
}

export function Card({
  title,
  action,
  children,
  className = "",
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white p-4 shadow-sm ${className}`}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-sm text-slate-500">{children}</p>;
}
