import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gatherAdvisorInputs, refreshAdvisor } from "@/lib/advisor/advisor";
import * as t from "@/lib/db/schema";
import { MockEmbeddingProvider, MockProvider } from "@/lib/llm/mock";
import type { GenerateRequest } from "@/lib/llm/types";
import { whatsChanged } from "@/lib/memory/changes";
import { searchMemory } from "@/lib/memory/memory";
import { syncAccountMemory } from "@/lib/memory/sync";
import { DEV_IDENTITY, upsertUser } from "@/lib/users";
import { createTestDb, hasTestDb, type TestDb } from "./db-helpers";

const NOW = new Date("2026-10-30T00:00:00Z");

describe.skipIf(!hasTestDb)("account memory and the sales advisor", () => {
  let tdb: TestDb;
  let userId: string;
  let accountId: string;
  let signalId: string;
  const embedder = new MockEmbeddingProvider(32);

  beforeAll(async () => {
    tdb = await createTestDb();
    userId = (await upsertUser(tdb.db, DEV_IDENTITY)).id;
    const [a] = await tdb.db.insert(t.accounts).values({ ownerUserId: userId, name: "Bellbird", lastContactAt: new Date("2026-10-25T00:00:00Z") }).returning();
    accountId = a!.id;
    const [src] = await tdb.db.insert(t.sources).values({ url: "https://news.example/ciso", adapter: "test", sourceType: "news" }).returning();
    const [s] = await tdb.db
      .insert(t.signals)
      .values({ accountId, sourceId: src!.id, channel: "news", signalType: "leadership_change", importance: "high", title: "New CISO appointed", whyItMatters: "Security review coming", occurredAt: new Date("2026-10-20T00:00:00Z"), classifiedAt: NOW, classifier: "test", dedupeKey: "k1" })
      .returning();
    signalId = s!.id;
    await tdb.db.insert(t.notes).values([
      { accountId, authorUserId: userId, kind: "meeting", body: "Priya worried about Copilot cost without a pilot.", occurredAt: new Date("2026-10-25T00:00:00Z") },
      { accountId, authorUserId: userId, kind: "next_step", body: "Send renewal options", occurredAt: new Date("2026-10-25T00:00:00Z"), dueOn: "2026-12-19" },
    ]);
    await tdb.db.insert(t.stakeholders).values({ accountId, fullName: "Priya Natarajan", title: "CIO", function: "cio", relationship: "champion", lastContactedAt: new Date("2026-08-01T00:00:00Z") });
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it("indexes notes and signals once, and finds them again", async () => {
    expect(await syncAccountMemory(tdb.db, embedder, accountId)).toBe(3);
    expect(await syncAccountMemory(tdb.db, embedder, accountId)).toBe(0);
    // The mock embedder isn't semantic: identical text is distance 0, which is enough to test the plumbing.
    const hits = await searchMemory(tdb.db, embedder, accountId, "next step: Send renewal options");
    expect(hits[0]).toMatchObject({ kind: "note", distance: expect.closeTo(0, 5) });
    expect(new Set(hits.map((h) => h.refId)).size).toBe(hits.length);
  });

  it("only compares vectors from the same model", async () => {
    expect(await searchMemory(tdb.db, new MockEmbeddingProvider(16), accountId, "anything")).toEqual([]);
  });

  it("gathers labelled evidence and computed facts, with a stable fingerprint", async () => {
    const a = await gatherAdvisorInputs(tdb.db, embedder, accountId, NOW);
    const b = await gatherAdvisorInputs(tdb.db, embedder, accountId, NOW);
    expect(a!.fingerprint).toBe(b!.fingerprint);
    expect(a!.evidence.map((e) => e.ref.kind).sort()).toEqual(["note", "note", "signal"]);
    expect(a!.facts).toContain("Last contact was 5 days ago.");
    expect(a!.facts.some((f) => f.startsWith("Champion Priya Natarajan hasn't been contacted"))).toBe(true);
  });

  it("keeps only advice with valid evidence, supersedes old advice, and skips unchanged inputs", async () => {
    let calls = 0;
    const llm = new MockProvider((req: GenerateRequest) => {
      calls++;
      const content = String(req.messages[0]!.content);
      const signal = /(E\d+) \([^)]*\): \[high leadership change\]/.exec(content)![1];
      return {
        nextBestActions: [
          { title: "Meet the new CISO", who: "Priya Natarajan", why: "Security review coming", evidence: [signal] },
          { title: "Unsupported idea", who: null, why: "Gut feel", evidence: ["E99"] },
        ],
        triggerAlerts: [],
        talkingPoints: [{ title: "Copilot pilot design", angle: "Prove value before spend", evidence: ["E2"] }],
        riskFlags: [{ title: "Champion going quiet", detail: "Priya not contacted since August", kind: "champion", evidence: ["E2"] }],
      };
    });
    const first = await refreshAdvisor(tdb.db, llm, embedder, accountId, { now: NOW });
    expect(first).toEqual({ status: "refreshed", created: 3, dropped: 1 });
    const recs = await tdb.db.select().from(t.recommendations).where(and(eq(t.recommendations.accountId, accountId), eq(t.recommendations.status, "active")));
    const nba = recs.find((r) => r.kind === "next_best_action")!;
    expect(nba.evidence).toEqual([{ kind: "signal", signalId }]);
    expect(nba.targetStakeholderId).not.toBeNull();
    expect(recs.find((r) => r.kind === "risk_flag")!.body).toMatch(/^Champion: /);

    expect(await refreshAdvisor(tdb.db, llm, embedder, accountId, { now: NOW })).toMatchObject({ status: "unchanged" });
    expect(calls).toBe(1);

    await refreshAdvisor(tdb.db, llm, embedder, accountId, { now: NOW, force: true });
    const all = await tdb.db.select().from(t.recommendations).where(eq(t.recommendations.accountId, accountId));
    expect(all.filter((r) => r.status === "superseded")).toHaveLength(3);
    expect(all.filter((r) => r.status === "active")).toHaveLength(3);
  });

  it("lists what changed since the last visit", async () => {
    const res = await whatsChanged(tdb.db, accountId, userId, new Date("2026-10-01T00:00:00Z"));
    expect(res.items[0]!.title).toBe("New CISO appointed");
    expect(res.counts.note).toBe(2);
    expect((await whatsChanged(tdb.db, accountId, userId, null)).items).toEqual([]);
  });
});
