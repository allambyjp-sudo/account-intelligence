import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as t from "@/lib/db/schema";
import { seedFictionalAccounts } from "@/lib/demo/seed";
import { syncConnection } from "@/lib/email/connections";
import { loadInbox } from "@/lib/email/inbox";
import { SyntheticMailSource } from "@/lib/email/sources/synthetic";
import { MockProvider } from "@/lib/llm/mock";
import type { GenerateRequest } from "@/lib/llm/types";
import { raiseQuietAlerts } from "@/lib/monitor/quiet";
import { DEV_IDENTITY, upsertUser } from "@/lib/users";
import { createTestDb, hasTestDb, type TestDb } from "./db-helpers";

describe.skipIf(!hasTestDb)("email ingestion end to end (synthetic mailbox)", () => {
  let tdb: TestDb;
  let userId: string;
  let ids: string[];
  let connectionId: string;
  const env = { ORG_EMAIL_DOMAINS: "seller.example" };

  const llm = new MockProvider((req: GenerateRequest) => {
    const content = String(req.messages[0]!.content);
    if (req.prompt?.id === "email.match") {
      const southern = /^([0-9a-f-]{36}): Southern Grid Energy/m.exec(content)![1];
      return { accountId: southern, confidence: 0.6, reason: "Partner delivering Southern Grid's project" };
    }
    const subject = /Subject: (.*)/.exec(content)![1]!;
    const classification = /EA renewal|Security review/.test(subject) ? "needs_reply" : /Tender/.test(subject) ? "needs_reply" : /Quote/.test(subject) ? "quote_or_renewal" : "info_only";
    return {
      summary: `Summary of ${subject}`,
      classification,
      deadlines: /EA renewal/.test(subject) ? [{ date: "2026-12-19", what: "Renewal scenarios" }] : [],
      actionItems: [],
    };
  });

  beforeAll(async () => {
    tdb = await createTestDb();
    userId = (await upsertUser(tdb.db, DEV_IDENTITY)).id;
    ids = await seedFictionalAccounts(tdb.db, userId);
    await raiseQuietAlerts(tdb.db);
    const [c] = await tdb.db.insert(t.mailConnections).values({ userId, provider: "synthetic", mailbox: "Synthetic" }).returning();
    connectionId = c!.id;
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it("stores only account mail, routes uncertain mail to Confirm, and never stores excluded, internal or personal mail", async () => {
    const res = await syncConnection(tdb.db, llm, connectionId, { env, entra: null, source: new SyntheticMailSource() });
    // Stored: two Bellbird threads, the Southern tender, the distributor quote and the consultant thread.
    expect(res).toMatchObject({ threadsStored: 5, pending: 2, skipped: 3, unmatched: 1 });

    const threads = await tdb.db.select().from(t.emailThreads).where(and(eq(t.emailThreads.userId, userId), eq(t.emailThreads.provider, "synthetic")));
    const by = (id: string) => threads.find((x) => x.providerThreadId === id);
    expect(by("kh-renewal")).toBeUndefined();
    expect(by("internal")).toBeUndefined();
    expect(by("personal")).toBeUndefined();
    expect(by("bb-ea")).toMatchObject({ accountId: ids[0], matchStatus: "auto", matchMethod: "sender_domain", classification: "needs_reply" });
    expect(by("dist-quote")).toMatchObject({ accountId: ids[0], matchStatus: "pending_confirmation", matchMethod: "partner_rule" });
    expect(by("sg-data")).toMatchObject({ accountId: ids[2], matchStatus: "pending_confirmation", matchMethod: "llm" });
    // We sent the last message on the tender thread, so we can't owe a reply.
    expect(by("sg-tender")!.classification).toBe("waiting_on_them");

    // Summaries and metadata only: no bodies unless the seller opts in.
    const summaries = await tdb.db.select().from(t.emailSummaries);
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.every((s) => s.bodyText === null)).toBe(true);
  });

  it("treats email as contact: last contact moves forward and the quiet alert closes", async () => {
    const [southern] = await tdb.db.select().from(t.accounts).where(eq(t.accounts.id, ids[2]!));
    expect(Date.now() - southern!.lastContactAt!.getTime()).toBeLessThan(5 * 86_400_000);
    const open = await tdb.db.select().from(t.alerts).where(and(eq(t.alerts.accountId, ids[2]!), eq(t.alerts.kind, "quiet_customer")));
    expect(open.every((a) => a.dismissedAt !== null)).toBe(true);
    const [sam] = await tdb.db.select().from(t.stakeholders).where(eq(t.stakeholders.fullName, "Sam Okafor"));
    expect(sam!.lastContactedAt).not.toBeNull();
  });

  it("orders the seller inbox and lists the Confirm queue", async () => {
    const inbox = await loadInbox(tdb.db, userId);
    expect(inbox.confirm.map((i) => i.thread.providerThreadId).sort()).toEqual(["dist-quote", "sg-data"]);
    // Both Bellbird threads owe a reply, so they lead; the newer one first.
    expect(inbox.priority.slice(0, 2).map((i) => i.thread.providerThreadId)).toEqual(["bb-ciso", "bb-ea"]);
    expect(inbox.priority.map((i) => i.thread.providerThreadId)).not.toContain("sg-data");
  });

  it("doesn't re-ingest on the next sync", async () => {
    const [conn] = await tdb.db.select().from(t.mailConnections).where(eq(t.mailConnections.id, connectionId));
    const again = await syncConnection(tdb.db, llm, connectionId, { env, entra: null, source: new SyntheticMailSource() });
    expect(again!.messages).toBe(0);
    expect(conn!.lastError).toBeNull();
  });

  it("purges stored email when an account is excluded later", async () => {
    await tdb.db.update(t.accounts).set({ emailExcluded: true, emailExcludedReason: "Sensitive" }).where(eq(t.accounts.id, ids[0]!));
    const left = await tdb.db.select().from(t.emailThreads).where(eq(t.emailThreads.accountId, ids[0]!));
    expect(left).toEqual([]);
  });
});
