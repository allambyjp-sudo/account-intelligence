import { createHash } from "node:crypto";
import type { Db } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import type { Importance, SignalChannel, SignalType } from "@/lib/domain/enums";

export const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

/** Syndicated stories share a headline but not a URL; key news on the normalised headline. */
export const newsKey = (title: string) => `news:${sha1(title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim())}`;

export interface NewSignal {
  accountId: string;
  sourceId: string;
  channel: SignalChannel;
  title: string;
  summary?: string | null;
  occurredAt: Date;
  dedupeKey: string;
  /** Rule-based signals (price moves) arrive already classified. */
  classified?: { signalType: SignalType; importance: Importance; classifier: string; whyItMatters?: string };
}

/** Inserts a signal unless the account already has one with the same key. Returns it only if new. */
export async function recordSignal(db: Db, s: NewSignal): Promise<t.Signal | null> {
  const [row] = await db
    .insert(t.signals)
    .values({
      accountId: s.accountId,
      sourceId: s.sourceId,
      channel: s.channel,
      title: s.title.slice(0, 500),
      summary: s.summary?.slice(0, 2000) ?? null,
      occurredAt: s.occurredAt,
      dedupeKey: s.dedupeKey,
      ...(s.classified
        ? {
            signalType: s.classified.signalType,
            importance: s.classified.importance,
            classifier: s.classified.classifier,
            classifiedAt: new Date(),
            whyItMatters: s.classified.whyItMatters ?? null,
          }
        : {}),
    })
    .onConflictDoNothing({ target: [t.signals.accountId, t.signals.dedupeKey] })
    .returning();
  return row ?? null;
}
