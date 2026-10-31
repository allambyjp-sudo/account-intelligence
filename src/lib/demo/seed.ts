import { and, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import * as t from "@/lib/db/schema";

/**
 * Fictional demo accounts for development. Every company, person and URL here is invented, and
 * every domain is on the reserved .example TLD (RFC 2606), so none of it can collide with a real
 * organisation. tests/no-real-data.test.ts enforces that.
 *
 * Re-running replaces the previous fictional accounts for the same owner. Real accounts are never
 * touched: only rows with is_fictional = true, and sources with adapter = 'seed'.
 */
export const SEED_ADAPTER = "seed";
const SEED_PROMPT = { promptId: "seed.fictional", promptVersion: 1, model: "none (seed data)" };
const DAY = 86_400_000;

export async function seedFictionalAccounts(db: Db, ownerUserId: string, now = new Date()): Promise<string[]> {
  const ago = (days: number) => new Date(now.getTime() - days * DAY);

  return db.transaction(async (tx) => {
    await tx.delete(t.accounts).where(and(eq(t.accounts.ownerUserId, ownerUserId), eq(t.accounts.isFictional, true)));
    const orphans = await tx.select({ id: t.sources.id }).from(t.sources).where(eq(t.sources.adapter, SEED_ADAPTER));
    // Seed sources still cited by another owner's fictional accounts stay (the delete is refused); the rest go.
    for (const { id } of orphans) {
      await tx.transaction((sp) => sp.delete(t.sources).where(eq(t.sources.id, id))).catch(() => undefined);
    }

    const source = async (url: string, sourceType: t.Source["sourceType"], title: string, publisher: string, publishedDaysAgo: number) => {
      const [row] = await tx
        .insert(t.sources)
        .values({ url, sourceType, title, publisher, adapter: SEED_ADAPTER, publishedAt: ago(publishedDaysAgo), retrievedAt: ago(1) })
        .onConflictDoUpdate({ target: [t.sources.url, t.sources.contentHash], set: { retrievedAt: ago(1) } })
        .returning();
      return row!;
    };
    const cited = (s: t.Source) => ({ sourceId: s.id, retrievedAt: s.retrievedAt, verification: "verified" as const });

    // ---- Bellbird Logistics Group: a key account with a fresh trigger -------------------------------
    const [bellbird] = await tx
      .insert(t.accounts)
      .values({
        ownerUserId,
        name: "Bellbird Logistics Group",
        status: "active",
        isKeyAccount: true,
        isFictional: true,
        lastContactAt: ago(5),
        lastResearchedAt: ago(1),
      })
      .returning();
    const b = bellbird!;
    const bAbout = await source("https://bellbird-logistics.example/about", "web", "About Bellbird", "Bellbird Logistics Group", 200);
    const bLeaders = await source("https://bellbird-logistics.example/leadership", "web", "Our leadership team", "Bellbird Logistics Group", 30);
    const bCiso = await source("https://news.example/2026/bellbird-appoints-ciso", "news", "Bellbird names first dedicated CISO", "Example Tech News", 16);
    const bJob = await source("https://jobs.example/bellbird/cloud-platform-engineer", "job_ad", "Cloud Platform Engineer (Azure)", "Example Jobs", 9);
    const bTender = await source("https://tenders.example/contract-notices/CN-0001", "tender", "Freight consolidation services: contract notice", "Example Tenders", 30);
    const bCase = await source("https://itsm-vendor.example/customers/bellbird", "case_study", "How Bellbird unified IT service management", "Example ITSM Vendor", 400);
    const bDepot = await source("https://news.example/2026/bellbird-brisbane-depot", "news", "Bellbird opens Brisbane cross-dock", "Example Business News", 3);

    await tx.insert(t.entities).values({
      accountId: b.id,
      legalName: "Bellbird Logistics Group Pty Ltd",
      country: "AU",
      domain: "bellbird-logistics.example",
      industry: "Transport, postal and warehousing",
      headcount: 2400,
      isPrimary: true,
      confidence: "high",
      ...cited(bAbout),
    });

    const [priya, sam, , mere] = await tx
      .insert(t.stakeholders)
      .values([
        { accountId: b.id, fullName: "Priya Natarajan", title: "Chief Information Officer", function: "cio", relationship: "champion", tenureStartedOn: "2022-03-01", lastContactedAt: ago(5), confidence: "high", ...cited(bLeaders) },
        {
          accountId: b.id,
          fullName: "Sam Okafor",
          title: "Chief Information Security Officer",
          function: "ciso",
          tenureStartedOn: new Date(ago(16)).toISOString().slice(0, 10),
          publicStatements: [{ text: "Security has to be something our drivers and depot teams barely notice.", sourceId: bCiso.id }],
          confidence: "high",
          ...cited(bCiso),
        },
        { accountId: b.id, fullName: "Tom Whitlock", title: "Chief Financial Officer", function: "cfo", relationship: "neutral", confidence: "high", ...cited(bLeaders) },
        { accountId: b.id, fullName: "Mere Tamihana", title: "Head of Infrastructure", function: "infrastructure", relationship: "supporter" },
      ])
      .returning();

    await tx.insert(t.contactPoints).values([
      { stakeholderId: priya!.id, kind: "work_email", value: "priya.natarajan@bellbird-logistics.example", confidence: "published", sourceId: bLeaders.id, retrievedAt: bLeaders.retrievedAt },
      {
        stakeholderId: sam!.id,
        kind: "work_email",
        value: "sam.okafor@bellbird-logistics.example",
        confidence: "verified_pattern",
        pattern: "{first}.{last}@bellbird-logistics.example",
      },
      { stakeholderId: mere!.id, kind: "work_email", value: "mere.tamihana@bellbird-logistics.example", confidence: "inferred" },
    ]);

    await tx.insert(t.techStackItems).values([
      { accountId: b.id, vendor: "Microsoft", product: "Microsoft 365 E5", category: "productivity", evidenceKind: "job_ad", evidenceExcerpt: "administer our Microsoft 365 E5 tenant", confidence: "high", ...cited(bJob) },
      { accountId: b.id, vendor: "Microsoft", product: "Intune", category: "end_user", evidenceKind: "job_ad", evidenceExcerpt: "Intune device management for 1,800 handhelds", confidence: "medium", ...cited(bJob) },
      { accountId: b.id, vendor: "Example ITSM Vendor", product: "Service Management", category: "other", evidenceKind: "case_study", confidence: "high", ...cited(bCase) },
      { accountId: b.id, vendor: "AWS", product: "EC2", category: "cloud", evidenceKind: "web_footprint", confidence: "low" },
    ]);

    const [ciso] = await tx
      .insert(t.signals)
      .values([
        {
          accountId: b.id,
          sourceId: bCiso.id,
          channel: "news",
          signalType: "leadership_change",
          importance: "high",
          title: "Bellbird appoints its first dedicated CISO",
          summary: "Sam Okafor joins from a fictional ports operator. New security leaders typically review tooling in their first 90 days.",
          occurredAt: ago(16),
          classifiedAt: ago(15),
          classifier: "seed.fictional@1",
          dedupeKey: "seed:bellbird:ciso",
        },
        {
          accountId: b.id,
          sourceId: bJob.id,
          channel: "hiring",
          signalType: "new_tech_role",
          importance: "medium",
          title: "Hiring: Cloud Platform Engineer (Azure)",
          summary: "The ad mentions an Azure landing zone build and Microsoft 365 E5 administration.",
          occurredAt: ago(9),
          classifiedAt: ago(9),
          classifier: "seed.fictional@1",
          dedupeKey: "seed:bellbird:job",
        },
        {
          accountId: b.id,
          sourceId: bTender.id,
          channel: "tender",
          signalType: "tender",
          importance: "medium",
          title: "Awarded a state freight consolidation contract",
          occurredAt: ago(30),
          classifiedAt: ago(29),
          classifier: "seed.fictional@1",
          dedupeKey: "seed:bellbird:tender",
        },
        { accountId: b.id, sourceId: bDepot.id, channel: "news", title: "Bellbird opens a Brisbane cross-dock", occurredAt: ago(3), dedupeKey: "seed:bellbird:depot" },
      ])
      .returning();

    await tx.insert(t.alerts).values({
      userId: ownerUserId,
      accountId: b.id,
      signalId: ciso!.id,
      kind: "signal",
      importance: "high",
      title: "New CISO at Bellbird",
      body: "Leadership change in security: a natural moment to offer a posture review.",
      createdAt: ago(15),
    });

    await tx.insert(t.recommendations).values({
      accountId: b.id,
      kind: "next_best_action",
      title: "Introduce yourself to Sam Okafor, the new CISO",
      body: "Sam started 16 days ago as Bellbird's first dedicated CISO. The Azure job ad points to a Microsoft 365 E5 estate whose security features may be under-used. Offer a short security posture review, not a licensing pitch; Priya can make the introduction.",
      targetStakeholderId: sam!.id,
      evidence: [
        { kind: "source", sourceId: bCiso.id },
        { kind: "source", sourceId: bJob.id },
      ],
      inputFingerprint: "seed",
      ...SEED_PROMPT,
    });

    await tx.insert(t.briefSections).values({
      accountId: b.id,
      section: "profile",
      version: 1,
      content: { note: "Fictional seed content" },
      summaryMd: `Bellbird Logistics Group is a fictional Melbourne-based freight and warehousing business with about 2,400 staff across depots on the east coast.[[src:${bAbout.id}]] It recently won a state freight consolidation contract[[src:${bTender.id}]] and opened a Brisbane cross-dock.[[src:${bDepot.id}]]`,
      sourceIds: [bAbout.id, bTender.id, bDepot.id],
      ...SEED_PROMPT,
    });

    await tx.insert(t.notes).values({
      accountId: b.id,
      authorUserId: ownerUserId,
      kind: "meeting",
      body: "Coffee with Priya. EA renews mid-2027; she wants options before Christmas, and is wary of Copilot spend without a pilot.",
      occurredAt: ago(5),
    });

    const [thread] = await tx
      .insert(t.emailThreads)
      .values({
        userId: ownerUserId,
        accountId: b.id,
        provider: "synthetic",
        // Same thread ID as the synthetic mailbox, so a demo sync extends this thread instead of duplicating it.
        providerThreadId: "bb-ea",
        subject: "Re: EA renewal timing",
        participants: [{ address: "priya.natarajan@bellbird-logistics.example", name: "Priya Natarajan", role: "from" }],
        firstMessageAt: ago(8),
        lastMessageAt: ago(5),
        lastInboundAt: ago(5),
        matchMethod: "sender_domain",
        matchConfidence: "0.950",
        matchStatus: "auto",
        classification: "quote_or_renewal",
      })
      .returning();
    await tx.insert(t.emailSummaries).values({
      threadId: thread!.id,
      providerMessageId: "seed-1",
      summary: "Priya confirmed the Enterprise Agreement renews on 30 June 2027 and asked for consolidation options before Christmas.",
      deadlines: [{ date: "2026-12-19", what: "Send renewal options" }],
      actionItems: [{ owner: "us", what: "Draft two renewal scenarios" }],
      ...SEED_PROMPT,
    });

    // ---- Kōwhai Health Partners: NZ, excluded from email ---------------------------------------------
    const [kowhai] = await tx
      .insert(t.accounts)
      .values({
        ownerUserId,
        name: "Kōwhai Health Partners",
        status: "active",
        isFictional: true,
        emailExcluded: true,
        emailExcludedReason: "Health sector: excluded from email ingestion",
        lastContactAt: ago(20),
      })
      .returning();
    const k = kowhai!;
    const kAbout = await source("https://kowhai-health.example/about-us", "web", "About Kōwhai Health Partners", "Kōwhai Health Partners", 120);
    const kIncident = await source("https://news.example/2026/kowhai-phishing-incident", "news", "Kōwhai Health reports phishing incident", "Example NZ News", 6);
    await tx.insert(t.entities).values({
      accountId: k.id,
      legalName: "Kōwhai Health Partners Limited",
      country: "NZ",
      domain: "kowhai-health.example",
      industry: "Health care and social assistance",
      headcount: 650,
      isPrimary: true,
      confidence: "medium",
      ...cited(kAbout),
    });
    await tx.insert(t.stakeholders).values({ accountId: k.id, fullName: "Aroha Ngata", title: "General Manager, Digital", function: "cio", confidence: "medium", ...cited(kAbout) });
    const [incident] = await tx
      .insert(t.signals)
      .values({
        accountId: k.id,
        sourceId: kIncident.id,
        channel: "news",
        signalType: "cyber_incident",
        importance: "high",
        title: "Kōwhai Health reports a phishing incident",
        summary: "No patient data was accessed, according to the report. Staff credentials were reset.",
        occurredAt: ago(6),
        classifiedAt: ago(6),
        classifier: "seed.fictional@1",
        dedupeKey: "seed:kowhai:incident",
      })
      .returning();
    await tx.insert(t.alerts).values({
      userId: ownerUserId,
      accountId: k.id,
      signalId: incident!.id,
      kind: "signal",
      importance: "high",
      title: "Cyber incident reported at Kōwhai Health",
      createdAt: ago(6),
    });

    // ---- Southern Grid Energy: a key account that has gone quiet ------------------------------------
    const [southern] = await tx
      .insert(t.accounts)
      .values({ ownerUserId, name: "Southern Grid Energy", status: "prospect", isKeyAccount: true, isFictional: true, lastContactAt: ago(45) })
      .returning();
    const sAbout = await source("https://southern-grid.example/company", "web", "Company overview", "Southern Grid Energy", 90);
    await tx.insert(t.entities).values({
      accountId: southern!.id,
      legalName: "Southern Grid Energy Pty Ltd",
      country: "AU",
      domain: "southern-grid.example",
      industry: "Electricity, gas, water and waste services",
      headcount: 1100,
      isPrimary: true,
      confidence: "medium",
      ...cited(sAbout),
    });

    // Matching rules for the synthetic mailbox: a distributor and a newsletter sender.
    await tx
      .insert(t.emailMatchRules)
      .values([
        { userId: ownerUserId, kind: "partner", pattern: "distributor.example" },
        { userId: ownerUserId, kind: "ignore", pattern: "newsletters.example" },
      ])
      .onConflictDoNothing();

    return [b.id, k.id, southern!.id];
  });
}
