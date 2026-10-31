import { and, desc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import type { BriefSectionKind, Confidence } from "@/lib/domain/enums";
import { addUsage, type LLMProvider, type LLMUsage } from "@/lib/llm/types";
import { getPrompt, renderPrompt } from "@/lib/prompts/loader";
import type { FootprintHit } from "@/lib/sources/footprint";
import { appearsIn, phoneAppearsIn, resolveClaim, resolveRefs, tokeniseSummary, type CitationStats, type ResolvedClaim } from "./citations";
import { inferAddress, isPersonalDomain } from "./contacts";
import type { SourcePack } from "./pack";
import * as S from "./schemas";

export interface SectionContext {
  db: Db;
  llm: LLMProvider;
  account: t.Account;
  entities: t.Entity[];
  pack: SourcePack;
  /** system.base + the sources block: identical for every section, so it caches. */
  system: string;
  now: Date;
  orgName: string;
  stats: CitationStats;
  usage: LLMUsage;
}

const today = (ctx: SectionContext) => ctx.now.toISOString().slice(0, 10);
const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

async function ask<T>(ctx: SectionContext, promptId: string, vars: Record<string, string>, schema: z.ZodType<T>) {
  const prompt = getPrompt(promptId);
  const res = await ctx.llm.generateStructured({
    task: "research",
    system: ctx.system,
    prompt: { id: prompt.id, version: prompt.version },
    messages: [{ role: "user", content: renderPrompt(prompt, vars) }],
    schema,
  });
  ctx.usage = addUsage(ctx.usage, res.usage);
  return { data: res.data, prompt: { id: prompt.id, version: prompt.version }, model: res.provenance.model };
}

async function saveSection(
  ctx: SectionContext,
  section: BriefSectionKind,
  content: unknown,
  summary: string,
  claimSourceIds: string[],
  meta: { prompt: { id: string; version: number }; model: string },
) {
  const tokenised = tokeniseSummary(summary, ctx.pack, ctx.stats);
  const [{ next }] = (await ctx.db
    .select({ next: sql<number>`coalesce(max(${t.briefSections.version}), 0) + 1` })
    .from(t.briefSections)
    .where(and(eq(t.briefSections.accountId, ctx.account.id), eq(t.briefSections.section, section)))) as [{ next: number }];
  await ctx.db.insert(t.briefSections).values({
    accountId: ctx.account.id,
    section,
    version: Number(next),
    content,
    summaryMd: tokenised.text,
    sourceIds: [...new Set([...tokenised.sourceIds, ...claimSourceIds])],
    promptId: meta.prompt.id,
    promptVersion: meta.prompt.version,
    model: meta.model,
    generatedAt: ctx.now,
  });
}

const idsOf = (claims: Array<ResolvedClaim | null | undefined>) => claims.flatMap((c) => c?.sourceIds ?? []);
const firstSource = (ctx: SectionContext, ids: string[]) => (ids[0] ? ctx.pack.entries.find((e) => e.source.id === ids[0])?.source : undefined);

// ---- Profile -----------------------------------------------------------------------------------

export async function runProfile(ctx: SectionContext) {
  const { data, prompt, model } = await ask(ctx, "research.profile", { company_name: ctx.account.name, today: today(ctx) }, S.profileOutput);
  const r = (c: { text: string; sources: string[]; confidence: Confidence } | null) => (c ? resolveClaim(c, ctx.pack, ctx.stats) : null);
  const content = {
    overview: r(data.overview),
    industry: data.industry,
    headquarters: r(data.headquarters),
    headcount: data.headcount ? { value: data.headcount.value, basis: r(data.headcount.basis) } : null,
    financials: data.financials.map((c) => r(c)!),
    ownership: r(data.ownership),
    subsidiaries: data.subsidiaries.map((s) => ({ name: s.name, claim: r(s.claim) })),
    history: data.history.map((h) => ({ when: h.when, claim: r(h.claim) })),
  };

  // Verified facts update the primary entity; unconfirmed ones stay in the brief only.
  const primary = ctx.entities.find((e) => e.isPrimary);
  if (primary) {
    const patch: Partial<t.Entity> = {};
    if (data.industry && !primary.industry) patch.industry = data.industry;
    if (content.headcount?.value && content.headcount.basis?.verification === "verified") patch.headcount = Math.round(content.headcount.value);
    if (content.headquarters?.verification === "verified") patch.headquarters = content.headquarters.text.slice(0, 200);
    if (Object.keys(patch).length) await ctx.db.update(t.entities).set(patch).where(eq(t.entities.id, primary.id));
  }

  const claims = [content.overview, content.headquarters, content.headcount?.basis, content.ownership, ...content.financials, ...content.subsidiaries.map((s) => s.claim), ...content.history.map((h) => h.claim)];
  await saveSection(ctx, "profile", content, data.summary, idsOf(claims), { prompt, model });
}

// ---- Stakeholders ------------------------------------------------------------------------------

export const accountDomains = (account: t.Account, entities: t.Entity[]) =>
  [
    ...new Set(
      [...entities.map((e) => e.domain), account.websiteUrl ? new URL(account.websiteUrl).host : null]
        .filter((d): d is string => Boolean(d))
        .map((d) => d.toLowerCase().replace(/^www\./, "")),
    ),
  ];

const nameKey = (n: string) => n.toLowerCase().replace(/\s+/g, " ").trim();

export async function runStakeholders(ctx: SectionContext) {
  const domains = accountDomains(ctx.account, ctx.entities);
  const { data, prompt, model } = await ask(
    ctx,
    "research.stakeholders",
    { company_name: ctx.account.name, today: today(ctx), domains: domains.join(", ") || "unknown" },
    S.stakeholdersOutput,
  );
  const existing = await ctx.db.select().from(t.stakeholders).where(eq(t.stakeholders.accountId, ctx.account.id));
  const people: unknown[] = [];

  for (const p of data.people) {
    const sourceIds = resolveRefs(p.sources, ctx.pack, ctx.stats);
    const verification = sourceIds.length ? "verified" : "unconfirmed";
    if (!sourceIds.length) ctx.stats.unconfirmedClaims++;
    const src = firstSource(ctx, sourceIds);

    // Quotes must appear in the source they cite; otherwise they're dropped, never paraphrased.
    const statements: t.PublicStatement[] = [];
    for (const s of p.statements) {
      const cited = ctx.pack.byRef.get(s.source.toUpperCase());
      if (cited && appearsIn(s.quote, cited.bodyText)) statements.push({ text: s.quote, sourceId: cited.id, ...(s.saidOn ? { saidOn: s.saidOn } : {}) });
      else ctx.stats.droppedQuotes++;
    }

    const values = {
      title: p.title,
      function: p.function,
      tenureStartedOn: /^\d{4}-\d{2}(-\d{2})?$/.test(p.tenureStartedOn ?? "") ? (p.tenureStartedOn!.length === 7 ? `${p.tenureStartedOn}-01` : p.tenureStartedOn) : null,
      priorRoles: p.priorRoles.map((r) => ({ organisation: r.organisation, title: r.title, ...(r.from ? { from: r.from } : {}), ...(r.to ? { to: r.to } : {}) })),
      publicStatements: statements,
      employmentStatus: "current" as const,
      sourceId: src?.id ?? null,
      retrievedAt: src?.retrievedAt ?? null,
      verification: src ? ("verified" as const) : ("unconfirmed" as const),
      confidence: p.confidence,
    };
    const match = existing.find((e) => nameKey(e.fullName) === nameKey(p.fullName));
    const [row] = match
      ? await ctx.db.update(t.stakeholders).set(values).where(eq(t.stakeholders.id, match.id)).returning()
      : await ctx.db.insert(t.stakeholders).values({ accountId: ctx.account.id, fullName: p.fullName, ...values }).returning();

    // Published contact details: printed exactly in the cited source, on the company's own domain.
    for (const e of p.workEmails) {
      const cited = ctx.pack.byRef.get(e.source.toUpperCase());
      const address = e.address.trim().toLowerCase();
      const domain = address.split("@")[1] ?? "";
      const onDomain = domains.some((d) => domain === d || domain.endsWith(`.${d}`));
      if (!cited || !onDomain || isPersonalDomain(domain) || !appearsIn(address, cited.bodyText)) {
        ctx.stats.droppedContacts++;
        continue;
      }
      await ctx.db
        .insert(t.contactPoints)
        .values({ stakeholderId: row!.id, kind: "work_email", value: address, confidence: "published", sourceId: cited.id, retrievedAt: cited.retrievedAt })
        .onConflictDoNothing();
    }
    for (const ph of p.workPhones) {
      const cited = ctx.pack.byRef.get(ph.source.toUpperCase());
      if (!cited || !phoneAppearsIn(ph.number, cited.bodyText)) {
        ctx.stats.droppedContacts++;
        continue;
      }
      await ctx.db
        .insert(t.contactPoints)
        .values({ stakeholderId: row!.id, kind: "work_phone", value: ph.number.trim(), confidence: "published", sourceId: cited.id, retrievedAt: cited.retrievedAt })
        .onConflictDoNothing();
    }
    people.push({ fullName: p.fullName, title: p.title, function: p.function, sourceIds, verification, confidence: p.confidence, statements });
  }

  await inferMissingEmails(ctx, domains);
  await saveSection(ctx, "stakeholders", { people }, data.summary, people.flatMap((p) => (p as { sourceIds: string[] }).sourceIds), { prompt, model });
}

/** Proposes work emails from published ones at the same domain. See contacts.ts for the rules. */
export async function inferMissingEmails(ctx: Pick<SectionContext, "db" | "account">, domains: string[]) {
  const domain = domains[0];
  if (!domain) return;
  const rows = await ctx.db
    .select({ s: t.stakeholders, c: t.contactPoints })
    .from(t.stakeholders)
    .leftJoin(t.contactPoints, and(eq(t.contactPoints.stakeholderId, t.stakeholders.id), eq(t.contactPoints.kind, "work_email")))
    .where(eq(t.stakeholders.accountId, ctx.account.id));
  const known = rows.filter((r) => r.c?.confidence === "published").map((r) => ({ fullName: r.s.fullName, email: r.c!.value }));
  const withEmail = new Set(rows.filter((r) => r.c).map((r) => r.s.id));
  const seen = new Set<string>();
  for (const { s } of rows) {
    if (withEmail.has(s.id) || seen.has(s.id) || s.employmentStatus === "departed") continue;
    seen.add(s.id);
    const guess = inferAddress(s.fullName, domain, known);
    if (!guess) continue;
    await ctx.db
      .insert(t.contactPoints)
      .values({ stakeholderId: s.id, kind: "work_email", value: guess.email, confidence: guess.confidence, pattern: guess.pattern })
      .onConflictDoNothing();
  }
}

// ---- Tech stack --------------------------------------------------------------------------------

export async function runTechStack(ctx: SectionContext, footprint: Array<{ hit: FootprintHit; sourceId: string }>) {
  const fp = footprint.map((f) => `- ${f.hit.vendor} ${f.hit.product} (seen: ${f.hit.evidence})`).join("\n") || "(none detected)";
  const { data, prompt, model } = await ask(ctx, "research.tech_stack", { company_name: ctx.account.name, footprint: fp }, S.techStackOutput);

  const items: Array<{ vendor: string; product: string; category: t.TechStackItem["category"]; evidenceKind: t.TechStackItem["evidenceKind"]; evidenceExcerpt: string | null; claim: ResolvedClaim }> = [];
  for (const f of footprint) {
    const src = ctx.pack.entries.find((e) => e.source.id === f.sourceId)?.source;
    items.push({
      vendor: f.hit.vendor,
      product: f.hit.product,
      category: f.hit.category,
      evidenceKind: "web_footprint",
      evidenceExcerpt: f.hit.evidence,
      claim: { text: `${f.hit.vendor} ${f.hit.product} is referenced in the website's code`, sourceIds: src ? [src.id] : [], confidence: "medium", verification: src ? "verified" : "unconfirmed" },
    });
  }
  for (const i of data.items) {
    const claim = resolveClaim({ text: `${i.vendor} ${i.product}`, sources: i.sources, confidence: i.confidence }, ctx.pack, ctx.stats);
    // An excerpt that isn't in any cited source can't carry more than low confidence.
    const supported = claim.sourceIds.some((id) => appearsIn(i.evidenceExcerpt, ctx.pack.entries.find((e) => e.source.id === id)?.source.bodyText));
    if (!supported) claim.confidence = "low";
    items.push({ vendor: i.vendor, product: i.product, category: i.category, evidenceKind: i.evidenceKind, evidenceExcerpt: i.evidenceExcerpt || null, claim });
  }

  const current = await ctx.db.select().from(t.techStackItems).where(eq(t.techStackItems.accountId, ctx.account.id));
  for (const i of items) {
    const src = firstSource(ctx, i.claim.sourceIds);
    const prev = current.find((c) => c.vendor.toLowerCase() === i.vendor.toLowerCase() && c.product.toLowerCase() === i.product.toLowerCase());
    const values = {
      category: i.category,
      evidenceKind: i.evidenceKind,
      evidenceExcerpt: i.evidenceExcerpt?.slice(0, 500) ?? null,
      lastSeenAt: ctx.now,
      sourceId: src?.id ?? null,
      retrievedAt: src?.retrievedAt ?? null,
      verification: src ? ("verified" as const) : ("unconfirmed" as const),
      confidence: i.claim.confidence,
    };
    if (!prev) {
      await ctx.db.insert(t.techStackItems).values({ accountId: ctx.account.id, vendor: i.vendor, product: i.product, firstSeenAt: ctx.now, ...values });
    } else if (!src && prev.sourceId) {
      // Never let a weaker, unsourced sighting overwrite a sourced one.
      await ctx.db.update(t.techStackItems).set({ lastSeenAt: ctx.now }).where(eq(t.techStackItems.id, prev.id));
    } else {
      const confidence = CONFIDENCE_RANK[prev.confidence] > CONFIDENCE_RANK[values.confidence] && prev.sourceId ? prev.confidence : values.confidence;
      await ctx.db.update(t.techStackItems).set({ ...values, confidence }).where(eq(t.techStackItems.id, prev.id));
    }
  }

  const content = { items: items.map((i) => ({ vendor: i.vendor, product: i.product, category: i.category, evidenceKind: i.evidenceKind, ...i.claim })) };
  await saveSection(ctx, "tech_stack", content, data.summary, idsOf(items.map((i) => i.claim)), { prompt, model });
}

// ---- Challenges, licensing lens, services fit ----------------------------------------------------

export async function runChallenges(ctx: SectionContext) {
  const { data, prompt, model } = await ask(ctx, "research.challenges", { company_name: ctx.account.name, today: today(ctx) }, S.challengesOutput);
  const content = {
    challenges: data.challenges.map((c) => resolveClaim(c, ctx.pack, ctx.stats)),
    opportunities: data.opportunities.map((c) => resolveClaim(c, ctx.pack, ctx.stats)),
  };
  await saveSection(ctx, "challenges", content, data.summary, idsOf([...content.challenges, ...content.opportunities]), { prompt, model });
  return content;
}

export async function runLicensingLens(ctx: SectionContext) {
  const stack = await ctx.db.select().from(t.techStackItems).where(eq(t.techStackItems.accountId, ctx.account.id));
  const stackText = stack.map((s) => `- ${s.vendor} ${s.product} (${s.category}, ${s.confidence} confidence${s.verification === "unconfirmed" ? ", unconfirmed" : ""})`).join("\n") || "(none yet)";
  const { data, prompt, model } = await ask(ctx, "research.licensing_lens", { company_name: ctx.account.name, today: today(ctx), tech_stack: stackText }, S.licensingOutput);
  const content = {
    eaRenewal: { estimate: data.eaRenewal.estimate, reasoning: resolveClaim(data.eaRenewal.reasoning, ctx.pack, ctx.stats) },
    vendorFootprint: data.vendorFootprint.map((v) => ({ vendor: v.vendor, products: v.products, claim: resolveClaim(v.claim, ctx.pack, ctx.stats) })),
    openings: data.openings.map((c) => resolveClaim(c, ctx.pack, ctx.stats)),
  };
  const claims = [content.eaRenewal.reasoning, ...content.vendorFootprint.map((v) => v.claim), ...content.openings];
  await saveSection(ctx, "licensing_lens", content, data.summary, idsOf(claims), { prompt, model });
}

export async function runServicesFit(ctx: SectionContext, challenges: { challenges: ResolvedClaim[]; opportunities: ResolvedClaim[] } | null) {
  const catalogue = await ctx.db.select().from(t.servicesCatalogueItems).where(eq(t.servicesCatalogueItems.active, true));
  if (!catalogue.length) throw new Error("The services catalogue is empty. Run npm run catalogue:sync.");
  let points = challenges;
  if (!points) {
    const [latest] = await ctx.db
      .select()
      .from(t.briefSections)
      .where(and(eq(t.briefSections.accountId, ctx.account.id), eq(t.briefSections.section, "challenges")))
      .orderBy(desc(t.briefSections.version))
      .limit(1);
    points = (latest?.content as typeof challenges) ?? { challenges: [], opportunities: [] };
  }
  const list = [...points.challenges, ...points.opportunities].map((c) => `- ${c.text}`).join("\n") || "(none found)";
  const { data, prompt, model } = await ask(
    ctx,
    "research.services_fit",
    {
      company_name: ctx.account.name,
      org_name: ctx.orgName,
      challenges: list,
      catalogue: catalogue.map((c) => `${c.slug}: ${c.name}: ${c.summary}`).join("\n"),
    },
    S.servicesFitOutput,
  );
  const valid = new Set(catalogue.map((c) => c.slug));
  const matches = data.matches
    .map((m) => ({ painPoint: resolveClaim(m.painPoint, ctx.pack, ctx.stats), catalogueSlugs: m.catalogueSlugs.filter((s) => valid.has(s)), rationale: m.rationale }))
    .filter((m) => m.catalogueSlugs.length);
  await saveSection(ctx, "services_fit", { matches }, data.summary, idsOf(matches.map((m) => m.painPoint)), { prompt, model });
}
