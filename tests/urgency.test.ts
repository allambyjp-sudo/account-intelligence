import { describe, expect, it } from "vitest";
import { scoreUrgency } from "@/lib/accounts/urgency";

const now = new Date("2026-10-30T00:00:00Z");
const base = { openAlerts: { high: 0, medium: 0, low: 0 }, isKeyAccount: false, lastContactAt: null, quietAfterDays: 30, now };

describe("scoreUrgency", () => {
  it("ranks a high alert above a quiet key account above nothing", () => {
    const alert = scoreUrgency({ ...base, openAlerts: { high: 1, medium: 0, low: 0 } });
    const quiet = scoreUrgency({ ...base, isKeyAccount: true, lastContactAt: new Date("2026-09-01T00:00:00Z") });
    const calm = scoreUrgency({ ...base, lastContactAt: new Date("2026-10-29T00:00:00Z") });
    expect(alert.score).toBeGreaterThan(quiet.score);
    expect(quiet.score).toBeGreaterThan(calm.score);
    expect(calm.reasons).toEqual([]);
  });

  it("flags quiet key accounts only, including ones with no contact on record", () => {
    expect(scoreUrgency({ ...base, isKeyAccount: true }).reasons).toEqual(["No contact on record"]);
    expect(scoreUrgency({ ...base, isKeyAccount: false }).isQuiet).toBe(false);
    expect(scoreUrgency({ ...base, isKeyAccount: true, lastContactAt: new Date("2026-10-01T00:00:00Z") }).reasons).toEqual([]);
    expect(scoreUrgency({ ...base, isKeyAccount: true, lastContactAt: new Date("2026-09-30T00:00:00Z") }).reasons).toEqual(["Quiet for 30 days"]);
  });

  it("explains the score in plain English", () => {
    expect(scoreUrgency({ ...base, openAlerts: { high: 2, medium: 1, low: 0 } }).reasons).toEqual(["2 high alerts", "1 medium alert"]);
  });
});
