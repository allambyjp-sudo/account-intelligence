import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as t from "@/lib/db/schema";
import { MockEmbeddingProvider, MockProvider } from "@/lib/llm/mock";
import { generateMeetingPrep, type MeetingPrep } from "@/lib/meetings/prep";
import { DEV_IDENTITY, upsertUser } from "@/lib/users";
import { createTestDb, hasTestDb, type TestDb } from "./db-helpers";

describe.skipIf(!hasTestDb)("meeting prep", () => {
  let tdb: TestDb;
  let meetingId: string;
  let signalId: string;

  beforeAll(async () => {
    tdb = await createTestDb();
    const user = await upsertUser(tdb.db, DEV_IDENTITY);
    const [a] = await tdb.db.insert(t.accounts).values({ ownerUserId: user.id, name: "Bellbird", lastContactAt: new Date("2026-10-01T00:00:00Z") }).returning();
    const [src] = await tdb.db.insert(t.sources).values({ url: "https://news.example/ciso", adapter: "test", sourceType: "news" }).returning();
    const [s] = await tdb.db
      .insert(t.signals)
      .values({ accountId: a!.id, sourceId: src!.id, channel: "news", signalType: "leadership_change", importance: "high", title: "New CISO", occurredAt: new Date("2026-10-15T00:00:00Z"), classifiedAt: new Date(), classifier: "x", dedupeKey: "k" })
      .returning();
    signalId = s!.id;
    // Before the last contact: must not appear as a change.
    await tdb.db.insert(t.signals).values({ accountId: a!.id, sourceId: src!.id, channel: "news", title: "Old news", occurredAt: new Date("2026-09-01T00:00:00Z"), dedupeKey: "old" });
    await tdb.db.insert(t.notes).values({ accountId: a!.id, authorUserId: user.id, kind: "next_step", body: "Send renewal options", dueOn: "2026-12-19" });
    const [p] = await tdb.db.insert(t.stakeholders).values({ accountId: a!.id, fullName: "Sam Okafor", title: "CISO", function: "ciso", publicStatements: [{ text: "Quiet security", sourceId: src!.id }] }).returning();
    const [m] = await tdb.db.insert(t.meetings).values({ accountId: a!.id, createdBy: user.id, title: "Security catch-up", attendeeStakeholderIds: [p!.id], otherAttendees: [{ name: "Alex", role: "Procurement" }] }).returning();
    meetingId = m!.id;
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it("builds a cited one-pager and drops unsupported changes and actions", async () => {
    let prompt = "";
    const llm = new MockProvider((req) => {
      prompt = String(req.messages[0]!.content);
      return {
        purpose: "Scope a security review",
        situation: "New CISO in place.",
        attendees: [{ name: "Sam Okafor", role: "CISO", publicPriorities: "Quiet security", historyWithUs: "No history on record", evidence: ["E1"] }],
        openingAngles: [1, 2, 3, 4].map((i) => ({ angle: `Angle ${i}`, why: "because", evidence: ["E1"] })),
        objections: [],
        changesSinceLastContact: [
          { what: "New CISO", evidence: ["E1"] },
          { what: "Rumoured merger", evidence: [] },
        ],
        openActions: [
          { action: "Send renewal options", owner: "us", due: "2026-12-19", evidence: ["E2"] },
          { action: "Invented promise", owner: "them", due: null, evidence: ["E9"] },
        ],
      };
    });
    const prep = await generateMeetingPrep(tdb.db, llm, new MockEmbeddingProvider(16), meetingId, new Date("2026-10-30T00:00:00Z"));
    expect(prompt).toContain('Said publicly: "Quiet security"');
    expect(prompt).toContain("Alex, Procurement (not in the stakeholder list)");
    expect(prompt).not.toContain("Old news");
    expect(prep.openingAngles).toHaveLength(3);
    expect(prep.changesSinceLastContact.map((c) => c.what)).toEqual(["New CISO"]);
    expect(prep.openActions.map((c) => c.action)).toEqual(["Send renewal options"]);
    expect(prep.evidence[0]).toMatchObject({ ref: { kind: "signal", signalId }, url: "https://news.example/ciso" });

    const [stored] = await tdb.db.select().from(t.meetings).where(eq(t.meetings.id, meetingId));
    expect((stored!.prep as MeetingPrep).purpose).toBe("Scope a security review");
    expect(stored).toMatchObject({ promptId: "meeting.prep", promptVersion: 1, prepError: null });
  });
});
