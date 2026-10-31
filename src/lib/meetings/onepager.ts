import type { MeetingPrep } from "./prep";

/** A format-neutral one-pager. The web page, DOCX and PDF all render from this. */
export interface OnePager {
  title: string;
  subtitle: string;
  sections: Array<{ heading: string; paragraphs?: Array<{ text: string; cites: number[] }>; items?: Array<{ text: string; detail?: string; cites: number[] }> }>;
  sources: Array<{ n: number; label: string; url?: string; date: string }>;
  footer: string;
}

/** Ends a fragment with a full stop if it doesn't already end with punctuation. */
const stop = (s: string) => (/[.!?…]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

export function buildOnePager(input: { accountName: string; meetingTitle: string; scheduledFor: Date | null; attendees: string[]; prep: MeetingPrep; generatedAt: Date }, tz = "Australia/Melbourne"): OnePager {
  const { prep } = input;
  const fmt = new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  const when = input.scheduledFor ? fmt.format(input.scheduledFor) : "Date not set";
  return {
    title: `${input.accountName}: ${input.meetingTitle}`,
    subtitle: [when, input.attendees.length ? `With ${input.attendees.join(", ")}` : null].filter(Boolean).join(" · "),
    sections: [
      { heading: "Purpose", paragraphs: [{ text: prep.purpose, cites: [] }] },
      { heading: "Where things stand", paragraphs: [{ text: prep.situation, cites: [] }] },
      { heading: "Attendees", items: prep.attendees.map((a) => ({ text: `${a.name}, ${a.role}`, detail: `Priorities: ${stop(a.publicPriorities)} History with us: ${stop(a.historyWithUs)}`, cites: a.evidence })) },
      { heading: "Three ways to open", items: prep.openingAngles.map((a) => ({ text: a.angle, detail: a.why, cites: a.evidence })) },
      { heading: "Likely objections", items: prep.objections.map((o) => ({ text: o.objection, detail: `Response: ${o.response}`, cites: o.evidence })) },
      {
        heading: prep.lastContactAt ? `Since we last spoke (${new Intl.DateTimeFormat("en-AU", { timeZone: tz, day: "numeric", month: "short" }).format(new Date(prep.lastContactAt))})` : "Recent changes",
        items: prep.changesSinceLastContact.length ? prep.changesSinceLastContact.map((c) => ({ text: c.what, cites: c.evidence })) : [{ text: "Nothing new on record.", cites: [] }],
      },
      {
        heading: "Open actions",
        items: prep.openActions.length ? prep.openActions.map((a) => ({ text: `${a.owner === "us" ? "Us" : "Them"}: ${a.action}`, detail: a.due ? `Due ${a.due}` : undefined, cites: a.evidence })) : [{ text: "None on record.", cites: [] }],
      },
    ],
    sources: prep.evidence.map((e, i) => ({ n: i + 1, label: e.label, url: e.url, date: e.at })),
    footer: `Prepared ${new Intl.DateTimeFormat("en-AU", { timeZone: tz, day: "numeric", month: "short", year: "numeric" }).format(input.generatedAt)} by Account Intelligence. Check anything marked as an estimate before relying on it.`,
  };
}

export const citeText = (cites: number[]) => (cites.length ? ` [${cites.join(", ")}]` : "");

/** Safe filename stem from the title. */
export const fileStem = (title: string) =>
  title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "meeting-prep";
