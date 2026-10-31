import { and, desc, eq, ne } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import type { PoliteFetcher } from "@/lib/http";
import { alphaVantageDaily, asxAnnouncements, austender } from "@/lib/sources/adapters/market";
import { configuredFeeds, googleNews } from "@/lib/sources/adapters/news";
import { careersPage } from "@/lib/sources/adapters/web";
import { latestVersion, upsertSource } from "@/lib/sources/store";
import { normaliseName, SourceDisabledError, SourceNotConfiguredError, type AdapterContext } from "@/lib/sources/types";
import { addedLines } from "./careers";
import { detectPriceMove } from "./price";
import { newsKey, recordSignal, sha1 } from "./signals";

export interface MonitorDeps {
  db: Db;
  fetcher: PoliteFetcher;
  env: Record<string, string | undefined>;
  now?: () => Date;
}

export interface MonitorResult {
  newSignals: number;
  skipped: Record<string, string>;
  failed: Record<string, string>;
}

const DAY = 86_400_000;

/**
 * One monitoring pass for an account (brief, section 4.4): news, ANZ press, announcements, tenders,
 * careers-page changes and share price. New items become unclassified signals; the classifier runs
 * next. Old items (older than 14 days) never become signals, so a first poll doesn't flood the timeline.
 */
export async function monitorAccount(deps: MonitorDeps, accountId: string): Promise<MonitorResult> {
  const { db, fetcher, env } = deps;
  const now = deps.now?.() ?? new Date();
  const ctx: AdapterContext = { fetcher, env, now: () => now };
  const result: MonitorResult = { newSignals: 0, skipped: {}, failed: {} };
  const [account] = await db.select().from(t.accounts).where(eq(t.accounts.id, accountId)).limit(1);
  if (!account) return result;
  const entities = await db.select().from(t.entities).where(eq(t.entities.accountId, accountId));
  const primary = entities.find((e) => e.isPrimary) ?? entities[0];
  const names = [...new Set([account.name, ...entities.map((e) => e.legalName)])];
  const cutoff = new Date(now.getTime() - 14 * DAY);

  const attempt = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof SourceNotConfiguredError || err instanceof SourceDisabledError) result.skipped[name] = err.message;
      else result.failed[name] = err instanceof Error ? err.message : String(err);
    }
  };
  const count = (s: unknown) => {
    if (s) result.newSignals++;
  };

  await attempt("google_news", async () => {
    const items = await googleNews.fetch({ companyName: account.name, ticker: primary?.ticker, extraTerms: account.newsTerms, region: primary?.country === "NZ" ? "NZ" : "AU", days: 7 }, ctx);
    for (const r of items) {
      if (r.publishedAt && r.publishedAt < cutoff) continue;
      const src = await upsertSource(db, r);
      count(await recordSignal(db, { accountId, sourceId: src.id, channel: "news", title: r.title ?? r.url, summary: r.text, occurredAt: r.publishedAt ?? now, dedupeKey: newsKey(r.title ?? r.url) }));
    }
  });

  await attempt("feeds", async () => {
    const res = await configuredFeeds.fetch({ kind: "news", terms: [...names, ...account.newsTerms] }, ctx);
    for (const f of res.failures) result.failed[`feed_${f.feed}`] = f.error;
    for (const r of res.records) {
      if (r.publishedAt && r.publishedAt < cutoff) continue;
      const src = await upsertSource(db, r);
      count(await recordSignal(db, { accountId, sourceId: src.id, channel: "news", title: r.title ?? r.url, summary: r.text, occurredAt: r.publishedAt ?? now, dedupeKey: newsKey(r.title ?? r.url) }));
    }
  });

  if (primary?.ticker && primary.exchange === "ASX") {
    await attempt("asx_announcements", async () => {
      for (const r of await asxAnnouncements.fetch({ ticker: primary.ticker!, companyName: account.name }, ctx)) {
        if (r.publishedAt && r.publishedAt < cutoff) continue;
        const src = await upsertSource(db, r);
        count(await recordSignal(db, { accountId, sourceId: src.id, channel: "announcement", title: r.title ?? "Announcement", summary: r.text, occurredAt: r.publishedAt ?? now, dedupeKey: `announcement:${sha1(r.url)}` }));
      }
    });
  }

  await attempt("austender", async () => {
    const since = account.lastPolledAt && account.lastPolledAt > new Date(now.getTime() - 7 * DAY) ? account.lastPolledAt : new Date(now.getTime() - 2 * DAY);
    const recs = await austender.fetch({ abn: primary?.abn ?? undefined, names: names.map(normaliseName), from: since, to: now }, ctx);
    for (const r of recs) {
      const src = await upsertSource(db, r);
      count(await recordSignal(db, { accountId, sourceId: src.id, channel: "tender", title: r.title ?? "Contract notice", summary: r.text, occurredAt: r.publishedAt ?? now, dedupeKey: `tender:${String(r.meta?.contractId ?? sha1(r.url))}` }));
    }
  });

  if (account.careersUrl) {
    await attempt("careers_page", async () => {
      const previous = await latestVersion(db, account.careersUrl!);
      const { record } = await careersPage.fetch({ url: account.careersUrl!, companyName: account.name }, ctx);
      if (previous?.contentHash === record.contentHash) return;
      const src = await upsertSource(db, record);
      // The first version is a baseline, not a change.
      if (!previous?.bodyText) return;
      const added = addedLines(previous.bodyText, record.text);
      if (!added.length) return;
      count(
        await recordSignal(db, {
          accountId,
          sourceId: src.id,
          channel: "careers_change",
          title: `Careers page changed: ${added.length} new line${added.length === 1 ? "" : "s"}`,
          summary: added.slice(0, 15).join("\n"),
          occurredAt: now,
          dedupeKey: `careers:${record.contentHash}`,
        }),
      );
    });
  }

  if (primary?.ticker && primary.exchange) {
    await attempt("alpha_vantage", async () => {
      // The free tier allows about 25 calls a day: once a day per listed account is the budget, so
      // go by when prices were last fetched (the source's retrieval time), not the last trade date.
      const [last] = await db
        .select({ fetchedAt: t.sources.retrievedAt })
        .from(t.pricePoints)
        .innerJoin(t.sources, eq(t.pricePoints.sourceId, t.sources.id))
        .where(eq(t.pricePoints.entityId, primary.id))
        .orderBy(desc(t.sources.retrievedAt))
        .limit(1);
      if (last && now.getTime() - last.fetchedAt.getTime() < 20 * 3_600_000) return;
      const series = await alphaVantageDaily.fetch({ exchange: primary.exchange!, ticker: primary.ticker!, companyName: account.name }, ctx);
      const src = await upsertSource(db, series.record);
      for (const p of series.points.slice(-120)) {
        await db
          .insert(t.pricePoints)
          .values({ entityId: primary.id, tradeDate: p.tradeDate, close: String(p.close), currency: series.currency as "AUD" | "NZD", sourceId: src.id })
          .onConflictDoUpdate({ target: [t.pricePoints.entityId, t.pricePoints.tradeDate], set: { close: String(p.close), sourceId: src.id } });
      }
      const move = detectPriceMove(series.points, account.name);
      if (move) {
        count(
          await recordSignal(db, {
            accountId,
            sourceId: src.id,
            channel: "share_price",
            title: move.title,
            summary: `Closed at ${series.currency} ${move.close}. ${move.dayChangePct}% on the day${move.vs30dPct !== null ? `, ${move.vs30dPct}% against the 30-day average` : ""}.`,
            occurredAt: new Date(`${move.tradeDate}T06:00:00Z`),
            dedupeKey: `price:${move.tradeDate}`,
            classified: { signalType: "other", importance: move.importance, classifier: "rules:price-move@1", whyItMatters: "A large share price move often comes with news that changes budgets or priorities." },
          }),
        );
      }
    });
  }

  await db.update(t.accounts).set({ lastPolledAt: now }).where(eq(t.accounts.id, accountId));
  return result;
}

/** Accounts worth polling: everything except dormant ones. */
export async function accountsToMonitor(db: Db): Promise<string[]> {
  const rows = await db.select({ id: t.accounts.id }).from(t.accounts).where(and(ne(t.accounts.status, "dormant")));
  return rows.map((r) => r.id);
}
