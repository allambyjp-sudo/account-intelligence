import { describe, expect, it } from "vitest";
import { onePagerToDocx, onePagerToPdf } from "@/lib/meetings/export";
import { buildOnePager, fileStem } from "@/lib/meetings/onepager";
import type { MeetingPrep } from "@/lib/meetings/prep";
import { pdfToText } from "@/lib/sources/adapters/web";

const prep: MeetingPrep = {
  purpose: "Agree a security review scope with the new CISO.",
  situation: "Bellbird has a new CISO and an EA renewal in mid-2027.",
  attendees: [{ name: "Sam Okafor", role: "CISO", publicPriorities: "Quiet security for depot staff", historyWithUs: "No history on record", evidence: [1] }],
  openingAngles: [
    { angle: "Ask about the first 90 days", why: "New leaders set priorities early", evidence: [1] },
    { angle: "Frontline device security", why: "1,800 handhelds", evidence: [2] },
    { angle: "Renewal timing", why: "Options due before Christmas", evidence: [3] },
  ],
  objections: [{ objection: "We just bought tools", response: "Start from what they already own", evidence: [] }],
  changesSinceLastContact: [{ what: "New CISO appointed", evidence: [1] }],
  openActions: [{ action: "Send renewal options", owner: "us", due: "2026-12-19", evidence: [3] }],
  evidence: [
    { ref: { kind: "signal", signalId: "00000000-0000-0000-0000-000000000001" }, label: "Bellbird appoints CISO", url: "https://news.example/ciso", at: "2026-10-15" },
    { ref: { kind: "note", noteId: "00000000-0000-0000-0000-000000000002" }, label: "Note: 1,800 handhelds", at: "2026-10-20" },
    { ref: { kind: "email", threadId: "00000000-0000-0000-0000-000000000003" }, label: "Email: Re: EA renewal timing", at: "2026-10-26" },
  ],
  lastContactAt: "2026-10-25T00:00:00.000Z",
};
const op = buildOnePager({ accountName: "Bellbird", meetingTitle: "Security catch-up", scheduledFor: new Date("2026-11-04T23:00:00Z"), attendees: ["Sam Okafor"], prep, generatedAt: new Date("2026-10-30T00:00:00Z") });

describe("meeting one-pager", () => {
  it("lays out every part of the brief's meeting prep, in Melbourne time", () => {
    expect(op.title).toBe("Bellbird: Security catch-up");
    expect(op.subtitle).toMatch(/^Thu,? 5 Nov 2026, 10:00\s?am · With Sam Okafor$/);
    expect(op.sections.map((s) => s.heading)).toEqual(["Purpose", "Where things stand", "Attendees", "Three ways to open", "Likely objections", "Since we last spoke (25 Oct)", "Open actions"]);
    expect(op.sections[3]!.items).toHaveLength(3);
    expect(op.sources.map((s) => s.n)).toEqual([1, 2, 3]);
  });

  it("makes safe file names", () => {
    expect(fileStem("Kōwhai Health: Q4 / review")).toBe("Kowhai-Health-Q4-review");
  });

  it("exports a Word document", async () => {
    const buf = await onePagerToDocx(op);
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    expect(buf.length).toBeGreaterThan(5000);
  });

  it("exports a PDF whose text reads back", async () => {
    const buf = await onePagerToPdf(op);
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    const { text } = await pdfToText(new Uint8Array(buf));
    expect(text).toContain("Bellbird: Security catch-up");
    expect(text).toContain("Three ways to open");
    expect(text).toContain("Ask about the first 90 days");
  });
});
