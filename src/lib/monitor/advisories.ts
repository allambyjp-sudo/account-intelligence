import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import type { PoliteFetcher } from "@/lib/http";
import { configuredFeeds } from "@/lib/sources/adapters/news";
import { mentions } from "@/lib/sources/feeds";
import { upsertSource } from "@/lib/sources/store";
import type { SourceRecord } from "@/lib/sources/types";
import { recordSignal, sha1 } from "./signals";

/** Product names too generic to match on their own ("CDN" would match half the internet). */
const GENERIC = new Set(["cdn", "s3", "ec2", "analytics", "tag manager", "cloud", "storage", "service management", "crm", "erp", "sharepoint online"]);

/** Terms that tie an advisory to an account's stack: specific product names, or vendor + product. */
export function stackTerms(items: Pick<t.TechStackItem, "vendor" | "product">[]): string[] {
  const out = new Set<string>();
  for (const i of items) {
    const product = i.product.replace(/\s*\(.*\)\s*$/, "").trim();
    if (product.length >= 4 && !GENERIC.has(product.toLowerCase()) && product.toLowerCase() !== i.vendor.toLowerCase()) out.add(product);
    out.add(`${i.vendor} ${product}`);
  }
  return [...out];
}

export function advisoryMatches(record: Pick<SourceRecord, "title" | "text">, items: Pick<t.TechStackItem, "vendor" | "product">[]): string[] {
  const text = `${record.title ?? ""}\n${record.text}`;
  return stackTerms(items).filter((term) => mentions(text, [term]));
}

/**
 * ASD's ACSC publishes advisories about products, not companies. Matching them against each
 * account's tech stack hypothesis turns them into account signals: "this flaw affects something
 * this customer probably runs".
 */
export async function matchAdvisories(db: Db, fetcher: PoliteFetcher, env: Record<string, string | undefined>, now = new Date()) {
  const { records, failures } = await configuredFeeds.fetch({ kind: "advisory" }, { fetcher, env, now: () => now });
  const recent = records.filter((r) => !r.publishedAt || now.getTime() - r.publishedAt.getTime() < 14 * 86_400_000);
  if (!recent.length) return { advisories: 0, signals: 0, failures };

  const stacks = await db.select().from(t.techStackItems);
  const byAccount = new Map<string, t.TechStackItem[]>();
  for (const s of stacks) byAccount.set(s.accountId, [...(byAccount.get(s.accountId) ?? []), s]);

  let signals = 0;
  for (const r of recent) {
    let sourceId: string | null = null;
    for (const [accountId, items] of byAccount) {
      const hits = advisoryMatches(r, items);
      if (!hits.length) continue;
      sourceId ??= (await upsertSource(db, r)).id;
      const [account] = await db.select({ status: t.accounts.status }).from(t.accounts).where(eq(t.accounts.id, accountId)).limit(1);
      if (!account || account.status === "dormant") continue;
      const s = await recordSignal(db, {
        accountId,
        sourceId,
        channel: "cyber_advisory",
        title: r.title ?? "Security advisory",
        summary: `Mentions ${hits.join(", ")}, which is in this account's tech stack hypothesis.\n${r.text.slice(0, 600)}`,
        occurredAt: r.publishedAt ?? now,
        dedupeKey: `advisory:${sha1(r.url)}`,
      });
      if (s) signals++;
    }
  }
  return { advisories: recent.length, signals, failures };
}
