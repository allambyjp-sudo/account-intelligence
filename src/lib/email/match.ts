import type { MatchMethod } from "@/lib/domain/enums";
import { isPersonalDomain } from "@/lib/research/contacts";
import { normaliseName } from "@/lib/sources/types";
import { domainOf, lower, type MailMessage } from "./types";

/**
 * Matching email to accounts (brief, section 4.8). The order:
 *   0. skip: internal-only mail, and mail that would land on an excluded account;
 *   1. seller-taught address rules (confirmations of people on personal or shared domains);
 *   2. sender domain: the account's own domains, plus seller-taught domain rules;
 *   3. known contacts: work emails of the account's stakeholders;
 *   4. partner and distributor rules: a distributor's email that names exactly one account;
 *   5. anything else with an external business party goes to the model.
 * Confidence below AUTO_THRESHOLD goes to the seller's Confirm queue.
 */
export const AUTO_THRESHOLD = 0.8;

export interface MatchAccount {
  id: string;
  name: string;
  domains: string[];
  excluded: boolean;
}

export interface MatchRule {
  kind: "domain" | "address" | "partner" | "ignore";
  pattern: string;
  accountId: string | null;
}

export interface MatchContext {
  /** The seller's own organisation (e.g. datacom.com): never matched, and internal-only mail is skipped. */
  ownDomains: string[];
  accounts: MatchAccount[];
  contacts: Array<{ address: string; accountId: string }>;
  rules: MatchRule[];
}

export type MatchResult =
  | { status: "skip"; reason: string }
  | { status: "auto" | "pending_confirmation"; accountId: string; method: MatchMethod; confidence: number; reason: string; candidates: string[] }
  | { status: "needs_model"; reason: string; candidates: string[]; externalDomains: string[] }
  | { status: "unmatched"; reason: string };

/**
 * Does the text name the account? Partners write "Bellbird Logistics", not "Bellbird Logistics Group
 * Pty Ltd", so both sides are normalised (legal suffixes and punctuation removed) and matched as whole words.
 */
export function namesAccount(text: string, account: Pick<MatchAccount, "name" | "domains">): boolean {
  const name = normaliseName(account.name);
  if (name.length >= 4 && ` ${normaliseName(text)} `.includes(` ${name} `)) return true;
  const lowered = text.toLowerCase();
  return account.domains.some((d) => lowered.includes(d));
}

/** Does `domain` equal `base` or sit under it (mail.bellbird.example under bellbird.example)? */
export const underDomain = (domain: string, base: string) => domain === base || domain.endsWith(`.${base}`);

export function externalParties(msg: Pick<MailMessage, "from" | "to" | "cc">, ctx: Pick<MatchContext, "ownDomains" | "rules">): string[] {
  const ignore = ctx.rules.filter((r) => r.kind === "ignore").map((r) => r.pattern);
  const all = [msg.from, ...msg.to, ...msg.cc].map((a) => lower(a.address)).filter((a) => a.includes("@"));
  return [...new Set(all)].filter((a) => {
    const d = domainOf(a);
    return !ctx.ownDomains.some((o) => underDomain(d, o)) && !ignore.some((i) => underDomain(d, i) || a === i);
  });
}

export function matchMessage(msg: Pick<MailMessage, "from" | "to" | "cc" | "subject" | "preview">, ctx: MatchContext): MatchResult {
  const parties = externalParties(msg, ctx);
  if (!parties.length) return { status: "skip", reason: "Internal or ignored senders only" };
  const byId = new Map(ctx.accounts.map((a) => [a.id, a]));

  const decide = (ids: string[], method: MatchMethod, confidence: number, reason: string): MatchResult => {
    const unique = [...new Set(ids)];
    // Excluded accounts opt out of email entirely: if the mail belongs to one, it's never stored.
    if (unique.some((id) => byId.get(id)?.excluded)) return { status: "skip", reason: "Matches an account excluded from email ingestion" };
    if (unique.length === 1) return { status: confidence >= AUTO_THRESHOLD ? "auto" : "pending_confirmation", accountId: unique[0]!, method, confidence, reason, candidates: unique };
    // Several accounts claim the same party (e.g. a shared government domain): ask the seller.
    return { status: "pending_confirmation", accountId: unique[0]!, method, confidence: Math.min(confidence, 0.5), reason: `${reason} (more than one account matches)`, candidates: unique };
  };

  // 1. Seller-taught address rules.
  const addressHits = ctx.rules.filter((r) => r.kind === "address" && r.accountId && parties.includes(r.pattern));
  if (addressHits.length) return decide(addressHits.map((r) => r.accountId!), "seller", 0.98, `Sender ${addressHits[0]!.pattern} was confirmed before`);

  // 2. Sender domain: account domains and seller-taught domain rules. Personal domains never count.
  const businessDomains = [...new Set(parties.map(domainOf))].filter((d) => !isPersonalDomain(d));
  const domainHits: Array<[string, string]> = [];
  for (const d of businessDomains) {
    for (const a of ctx.accounts) if (a.domains.some((ad) => underDomain(d, ad))) domainHits.push([a.id, d]);
    for (const r of ctx.rules) if (r.kind === "domain" && r.accountId && underDomain(d, r.pattern)) domainHits.push([r.accountId, d]);
  }
  if (domainHits.length) return decide(domainHits.map(([id]) => id), "sender_domain", 0.92, `Domain ${domainHits[0]![1]} belongs to the account`);

  // 3. Known contacts (covers people writing from personal or unusual domains).
  const contactHits = ctx.contacts.filter((c) => parties.includes(lower(c.address)));
  if (contactHits.length) return decide(contactHits.map((c) => c.accountId), "known_contact", 0.9, `${contactHits[0]!.address} is a known contact`);

  // 4. Partners and distributors: their mail is about our accounts, so look for exactly one named account.
  const partnerDomains = ctx.rules.filter((r) => r.kind === "partner").map((r) => r.pattern);
  const fromPartner = businessDomains.some((d) => partnerDomains.some((p) => underDomain(d, p)));
  if (fromPartner) {
    const named = ctx.accounts.filter((a) => namesAccount(`${msg.subject}\n${msg.preview}`, a));
    if (named.length === 1) return decide([named[0]!.id], "partner_rule", 0.7, `Partner email that names ${named[0]!.name}`);
    return { status: "unmatched", reason: named.length ? "Partner email naming several accounts" : "Partner email that doesn't name an account" };
  }

  // 5. The model decides, if there's a business party to reason about.
  if (!businessDomains.length) return { status: "unmatched", reason: "Only personal email addresses, none known" };
  const text = `${msg.subject}\n${msg.preview}`;
  const firstWord = (a: MatchAccount) => normaliseName(a.name).split(" ")[0] ?? "";
  const candidates = ctx.accounts
    .filter((a) => !a.excluded && (namesAccount(text, a) || (firstWord(a).length >= 4 && ` ${normaliseName(text)} `.includes(` ${firstWord(a)} `))))
    .map((a) => a.id);
  return { status: "needs_model", reason: "No rule matched", candidates, externalDomains: businessDomains };
}

/**
 * Turns a seller's confirmation into a rule, so the same sender matches by itself next time.
 * Business domains become domain rules; personal addresses become address rules; partner domains
 * teach nothing (their mail spans many accounts).
 */
export function ruleFromConfirmation(parties: string[], accountId: string, ctx: Pick<MatchContext, "rules" | "accounts">): MatchRule | null {
  const partners = ctx.rules.filter((r) => r.kind === "partner").map((r) => r.pattern);
  for (const p of parties) {
    const d = domainOf(p);
    if (partners.some((pd) => underDomain(d, pd))) continue;
    if (isPersonalDomain(d)) return { kind: "address", pattern: lower(p), accountId };
    // A domain that already belongs to some account would be ambiguous as a rule: teach the address.
    const owned = ctx.accounts.some((a) => a.domains.some((ad) => underDomain(d, ad)));
    return owned ? { kind: "address", pattern: lower(p), accountId } : { kind: "domain", pattern: d, accountId };
  }
  return null;
}
