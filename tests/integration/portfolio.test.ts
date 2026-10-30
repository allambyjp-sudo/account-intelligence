import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAccountPage, loadPortfolio } from "@/lib/accounts/queries";
import { seedFictionalAccounts } from "@/lib/demo/seed";
import { DEV_IDENTITY, upsertUser } from "@/lib/users";
import { createTestDb, hasTestDb, type TestDb } from "./db-helpers";

describe.skipIf(!hasTestDb)("fictional seed and dashboard queries", () => {
  let t: TestDb;
  let userId: string;
  let ids: string[];
  const now = new Date("2026-10-30T00:00:00Z");

  beforeAll(async () => {
    t = await createTestDb();
    userId = (await upsertUser(t.db, DEV_IDENTITY)).id;
    ids = await seedFictionalAccounts(t.db, userId, now);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("seeds idempotently", async () => {
    const again = await seedFictionalAccounts(t.db, userId, now);
    expect(again).toHaveLength(3);
    const { rows } = await t.pool.query(`SELECT count(*)::int AS n FROM accounts`);
    expect(rows[0].n).toBe(3);
    ids = again;
  });

  it("orders the portfolio by urgency and explains why", async () => {
    const rows = await loadPortfolio(t.db, userId, now);
    expect(rows.map((r) => r.account.name)).toEqual(["Bellbird Logistics Group", "Kōwhai Health Partners", "Southern Grid Energy"]);
    expect(rows[0]!.urgency.reasons).toEqual(["1 high alert"]);
    expect(rows[2]!.urgency.reasons).toEqual(["Quiet for 45 days"]);
  });

  it("loads the account page with citations for every verified claim", async () => {
    const page = await loadAccountPage(t.db, userId, ids[0]!);
    expect(page).not.toBeNull();
    expect(page!.stakeholders).toHaveLength(4);
    expect(page!.timeline.map((i) => i.kind)).toContain("email");
    for (const s of page!.stakeholders) {
      if (s.verification === "verified") expect(page!.sources.has(s.sourceId!)).toBe(true);
    }
    for (const r of page!.recommendations) {
      for (const e of r.evidence) if (e.kind === "source") expect(page!.sources.has(e.sourceId)).toBe(true);
    }
    expect(page!.brief.profile?.sourceIds.every((id) => page!.sources.has(id))).toBe(true);
  });

  it("never shows one seller another seller's account", async () => {
    const other = await upsertUser(t.db, { ...DEV_IDENTITY, objectId: "someone-else", email: "other@example.com" });
    expect(await loadAccountPage(t.db, other.id, ids[0]!)).toBeNull();
    expect(await loadPortfolio(t.db, other.id, now)).toEqual([]);
  });
});
