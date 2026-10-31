import { describe, expect, it } from "vitest";
import { AUTO_THRESHOLD, externalParties, matchMessage, ruleFromConfirmation, type MatchContext } from "@/lib/email/match";

// Fictional accounts on reserved domains. The seller works at "seller.example".
const BELLBIRD = "00000000-0000-0000-0000-00000000000b";
const KOWHAI = "00000000-0000-0000-0000-00000000000c";
const SOUTHERN = "00000000-0000-0000-0000-00000000000d";
const AGENCY_A = "00000000-0000-0000-0000-00000000000e";
const AGENCY_B = "00000000-0000-0000-0000-00000000000f";

const ctx: MatchContext = {
  ownDomains: ["seller.example"],
  accounts: [
    { id: BELLBIRD, name: "Bellbird Logistics", domains: ["bellbird-logistics.example"], excluded: false },
    { id: KOWHAI, name: "Kōwhai Health", domains: ["kowhai-health.example"], excluded: true },
    { id: SOUTHERN, name: "Southern Grid", domains: ["southern-grid.example"], excluded: false },
    { id: AGENCY_A, name: "Department of Examples", domains: ["gov.example"], excluded: false },
    { id: AGENCY_B, name: "Example Regulator", domains: ["gov.example"], excluded: false },
  ],
  contacts: [{ address: "mere.t@gmail.com", accountId: BELLBIRD }],
  rules: [
    { kind: "partner", pattern: "distributor.example", accountId: null },
    { kind: "ignore", pattern: "newsletters.example", accountId: null },
    { kind: "address", pattern: "consultant@contractor.example", accountId: SOUTHERN },
  ],
};

const msg = (from: string, to: string[] = ["me@seller.example"], subject = "Hello", preview = "") => ({
  from: { address: from },
  to: to.map((address) => ({ address })),
  cc: [],
  subject,
  preview,
});

describe("email matching", () => {
  it("skips internal-only mail and ignored senders", () => {
    expect(matchMessage(msg("colleague@seller.example"), ctx)).toMatchObject({ status: "skip" });
    expect(matchMessage(msg("news@mail.newsletters.example"), ctx)).toMatchObject({ status: "skip" });
  });

  it("matches on the sender's domain first, including subdomains", () => {
    const r = matchMessage(msg("priya@bellbird-logistics.example"), ctx);
    expect(r).toMatchObject({ status: "auto", accountId: BELLBIRD, method: "sender_domain" });
    expect(matchMessage(msg("it@mail.bellbird-logistics.example"), ctx)).toMatchObject({ accountId: BELLBIRD, method: "sender_domain" });
  });

  it("matches outbound mail by recipient", () => {
    expect(matchMessage(msg("me@seller.example", ["ops@southern-grid.example"]), ctx)).toMatchObject({ status: "auto", accountId: SOUTHERN });
  });

  it("never stores mail for an excluded account", () => {
    expect(matchMessage(msg("gm@kowhai-health.example"), ctx)).toMatchObject({ status: "skip", reason: expect.stringMatching(/excluded/) });
    // Even when another account is on the same thread.
    expect(matchMessage(msg("gm@kowhai-health.example", ["me@seller.example", "priya@bellbird-logistics.example"]), ctx)).toMatchObject({ status: "skip" });
  });

  it("sends a shared domain to the Confirm queue with both candidates", () => {
    const r = matchMessage(msg("someone@gov.example"), ctx);
    expect(r).toMatchObject({ status: "pending_confirmation", candidates: [AGENCY_A, AGENCY_B] });
  });

  it("matches known contacts writing from personal addresses, and never matches a personal domain on its own", () => {
    expect(matchMessage(msg("mere.t@gmail.com"), ctx)).toMatchObject({ status: "auto", accountId: BELLBIRD, method: "known_contact" });
    expect(matchMessage(msg("stranger@gmail.com"), ctx)).toMatchObject({ status: "unmatched" });
  });

  it("applies seller-taught address rules before anything else", () => {
    expect(matchMessage(msg("consultant@contractor.example"), ctx)).toMatchObject({ status: "auto", accountId: SOUTHERN, method: "seller" });
  });

  it("matches distributor email that names exactly one account, with confirmation", () => {
    const r = matchMessage(msg("quotes@distributor.example", ["me@seller.example"], "Quote for Bellbird Logistics renewal"), ctx);
    expect(r).toMatchObject({ status: "pending_confirmation", accountId: BELLBIRD, method: "partner_rule" });
    expect(r.status === "pending_confirmation" && r.confidence).toBeLessThan(AUTO_THRESHOLD);
    expect(matchMessage(msg("quotes@distributor.example", ["me@seller.example"], "Weekly pricing update"), ctx)).toMatchObject({ status: "unmatched" });
  });

  it("recognises an account named without its legal suffixes", () => {
    const withGroup = { ...ctx, accounts: ctx.accounts.map((a) => (a.id === BELLBIRD ? { ...a, name: "Bellbird Logistics Group Pty Ltd" } : a)) };
    expect(matchMessage(msg("quotes@distributor.example", ["me@seller.example"], "Quote for Bellbird Logistics - E5 renewal"), withGroup)).toMatchObject({ accountId: BELLBIRD, method: "partner_rule" });
  });

  it("hands unknown business senders to the model, with name-mention candidates", () => {
    const r = matchMessage(msg("pm@unknown-co.example", ["me@seller.example"], "Southern project kickoff"), ctx);
    expect(r).toMatchObject({ status: "needs_model", candidates: [SOUTHERN], externalDomains: ["unknown-co.example"] });
  });

  it("lists external parties without duplicates or own-domain addresses", () => {
    expect(externalParties({ from: { address: "A@Bellbird-Logistics.example" }, to: [{ address: "a@bellbird-logistics.example" }, { address: "me@seller.example" }], cc: [] }, ctx)).toEqual([
      "a@bellbird-logistics.example",
    ]);
  });
});

describe("learning from confirmations", () => {
  it("teaches a domain rule for a new business domain", () => {
    expect(ruleFromConfirmation(["pm@unknown-co.example"], SOUTHERN, ctx)).toEqual({ kind: "domain", pattern: "unknown-co.example", accountId: SOUTHERN });
  });

  it("teaches an address rule for personal domains and domains already owned by an account", () => {
    expect(ruleFromConfirmation(["someone@gmail.com"], SOUTHERN, ctx)).toEqual({ kind: "address", pattern: "someone@gmail.com", accountId: SOUTHERN });
    expect(ruleFromConfirmation(["x@gov.example"], AGENCY_B, ctx)).toEqual({ kind: "address", pattern: "x@gov.example", accountId: AGENCY_B });
  });

  it("learns nothing from a distributor", () => {
    expect(ruleFromConfirmation(["quotes@distributor.example"], BELLBIRD, ctx)).toBeNull();
  });
});
