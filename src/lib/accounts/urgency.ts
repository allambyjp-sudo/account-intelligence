import type { Importance } from "@/lib/domain/enums";

export interface UrgencyInput {
  openAlerts: Record<Importance, number>;
  isKeyAccount: boolean;
  lastContactAt: Date | null;
  quietAfterDays: number;
  now: Date;
}

export interface Urgency {
  score: number;
  /** Plain-English reasons, shown next to the account so the order is never a mystery. */
  reasons: string[];
  daysSinceContact: number | null;
  /** A key account with no contact for quietAfterDays or more (or none on record). */
  isQuiet: boolean;
}

const DAY_MS = 86_400_000;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Portfolio ordering: open alerts by importance first, then quiet key accounts. */
export function scoreUrgency(i: UrgencyInput): Urgency {
  const daysSinceContact = i.lastContactAt ? Math.floor((i.now.getTime() - i.lastContactAt.getTime()) / DAY_MS) : null;
  const isQuiet = i.isKeyAccount && (daysSinceContact === null || daysSinceContact >= i.quietAfterDays);
  const { high, medium, low } = i.openAlerts;

  const reasons: string[] = [];
  if (high) reasons.push(plural(high, "high alert"));
  if (medium) reasons.push(plural(medium, "medium alert"));
  if (low) reasons.push(plural(low, "low alert"));
  if (isQuiet) reasons.push(daysSinceContact === null ? "No contact on record" : `Quiet for ${daysSinceContact} days`);

  const score = high * 100 + medium * 20 + low * 5 + (isQuiet ? 60 : 0) + (i.isKeyAccount ? 10 : 0);
  return { score, reasons, daysSinceContact, isQuiet };
}
