import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as t from "@/lib/db/schema";
import { confirmIntake, resolveIntake } from "@/lib/intake/intake";
import { MockProvider } from "@/lib/llm/mock";
import type { GenerateRequest } from "@/lib/llm/types";
import { googleNewsUrl } from "@/lib/sources/adapters/news";
import { createResearchRun, runResearch } from "@/lib/research/run";
import { DEV_IDENTITY, upsertUser } from "@/lib/users";
import { fakeFetcher } from "../helpers/fake-fetcher";
import { createTestDb, hasTestDb, type TestDb } from "./db-helpers";

const HOME = "https://bellbird-logistics.example/";
const LEADERS = "https://bellbird-logistics.example/our-leadership";
const ABR_DETAILS = "https://abr.business.gov.au/json/AbnDetails.aspx?abn=51824753556&guid=g&callback=callback";

const homepage = `<html><head><title>Bellbird Logistics</title><script src="https://js.hs-scripts.com/1.js"></script></head>
  <body><main><p>Bellbird moves freight for 2,400 customers from 14 depots. We employ 2,400 people.</p>
  <a href="/our-leadership">Our leadership</a><a href="https://login.microsoftonline.com/x">Staff</a></main></body></html>`;
const leadership = `<html><body><main>
  <h2>Priya Natarajan, Chief Information Officer</h2><p>Contact: priya.natarajan@bellbird-logistics.example or (03) 9000 1234.</p>
  <p>Priya said: "Our depots run on data, and data has to be safe."</p>
  <h2>Tom Whitlock, Chief Financial Officer</h2><p>tom.whitlock@bellbird-logistics.example</p>
  <h2>Sam Okafor, Chief Information Security Officer</h2></main></body></html>`;
const abrDetails = `callback({"Abn":"51824753556","AbnStatus":"Active","AbnStatusEffectiveFrom":"2004-03-01","Acn":"123456789","AddressDate":null,"AddressPostcode":"3000","AddressState":"VIC","BusinessName":[],"EntityName":"BELLBIRD LOGISTICS GROUP PTY LTD","EntityTypeCode":"PRV","EntityTypeName":"Australian Private Company","Gst":null,"Message":""})`;
const rss = `<?xml version="1.0"?><rss version="2.0"><channel><item><title>Bellbird Logistics names new CISO - Example News</title><link>https://news.example/ciso</link><pubDate>Thu, 15 Oct 2026 01:00:00 GMT</pubDate><description>Sam Okafor joins Bellbird Logistics as CISO</description><source url="https://news.example">Example News</source></item></channel></rss>`;

/** Scripted model output per prompt, including deliberate mistakes the pipeline must catch. */
function scripted(req: GenerateRequest): unknown {
    switch (req.prompt?.id) {
      case "research.profile":
        return {
          summary: "Bellbird is a freight business [S2] with 2,400 staff [S2]. It is famous for llamas [S99].",
          overview: { text: "Freight and warehousing", sources: ["S2"], confidence: "high" },
          industry: "Transport and logistics",
          headquarters: { text: "Melbourne, Victoria", sources: ["S1"], confidence: "high" },
          headcount: { value: 2400, basis: { text: "2,400 people", sources: ["S2"], confidence: "high" } },
          financials: [{ text: "Revenue about $500m", sources: [], confidence: "low" }],
          ownership: null,
          subsidiaries: [],
          history: [],
        };
      case "research.stakeholders":
        return {
          summary: "Priya leads IT [S3].",
          people: [
            {
              fullName: "Priya Natarajan",
              title: "Chief Information Officer",
              function: "cio",
              tenureStartedOn: "2022-03",
              priorRoles: [],
              statements: [
                { quote: "Our depots run on data, and data has to be safe.", source: "S3", saidOn: null },
                { quote: "We will move everything to the cloud by Friday.", source: "S3", saidOn: null },
              ],
              workEmails: [
                { address: "priya.natarajan@bellbird-logistics.example", source: "S3" },
                { address: "priya.n@gmail.com", source: "S3" },
              ],
              workPhones: [{ number: "+61 3 9000 1234", source: "S3" }],
              sources: ["S3"],
              confidence: "high",
            },
            { fullName: "Tom Whitlock", title: "Chief Financial Officer", function: "cfo", tenureStartedOn: null, priorRoles: [], statements: [], workEmails: [{ address: "tom.whitlock@bellbird-logistics.example", source: "S3" }], workPhones: [], sources: ["S3"], confidence: "high" },
            { fullName: "Sam Okafor", title: "Chief Information Security Officer", function: "ciso", tenureStartedOn: null, priorRoles: [], statements: [], workEmails: [], workPhones: [], sources: ["S3", "S4"], confidence: "high" },
            { fullName: "Imaginary Person", title: "Head of Data", function: "data", tenureStartedOn: null, priorRoles: [], statements: [], workEmails: [], workPhones: [], sources: [], confidence: "low" },
          ],
        };
      case "research.tech_stack":
        return {
          summary: "Microsoft-centric [S2].",
          items: [
            { vendor: "Microsoft", product: "Microsoft 365", category: "productivity", evidenceKind: "web_footprint", evidenceExcerpt: "Staff", sources: ["S2"], confidence: "high" },
            { vendor: "SAP", product: "S/4HANA", category: "erp", evidenceKind: "news", evidenceExcerpt: "migrating to SAP", sources: ["S4"], confidence: "high" },
          ],
        };
      case "research.challenges":
        return {
          summary: "Security is in focus after a new CISO [S4].",
          challenges: [{ text: "Building a security function from scratch", sources: ["S4"], confidence: "medium" }],
          opportunities: [{ text: "Consolidating security tooling", sources: [], confidence: "low" }],
        };
      case "research.licensing_lens":
        return {
          summary: "Renewal timing unknown.",
          eaRenewal: { estimate: null, reasoning: { text: "No public evidence of agreement dates", sources: [], confidence: "low" } },
          vendorFootprint: [{ vendor: "Microsoft", products: ["Entra ID"], claim: { text: "Uses Entra ID for staff sign-in", sources: ["S2"], confidence: "medium" } }],
          openings: [],
        };
      case "research.services_fit":
        return {
          summary: "Security review fits [S4].",
          matches: [
            { painPoint: { text: "New security function", sources: ["S4"], confidence: "medium" }, catalogueSlugs: ["security-posture-review", "made-up-service"], rationale: "New CISO" },
            { painPoint: { text: "Nothing real", sources: [], confidence: "low" }, catalogueSlugs: ["not-in-catalogue"], rationale: "x" },
          ],
        };
      default:
        throw new Error(`unexpected prompt ${req.prompt?.id}`);
    }
}
const scriptedModel = () => new MockProvider(scripted);

describe.skipIf(!hasTestDb)("intake and the research agent", () => {
  let tdb: TestDb;
  let userId: string;
  let accountId: string;
  const env = { ABN_LOOKUP_GUID: "g", ORG_NAME: "Datacom" };

  beforeAll(async () => {
    tdb = await createTestDb();
    userId = (await upsertUser(tdb.db, DEV_IDENTITY)).id;
    await tdb.db.insert(t.servicesCatalogueItems).values({ slug: "security-posture-review", kind: "service", name: "Security posture review", summary: "s", isPlaceholder: true });
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it("resolves a typed name to registry candidates and creates a cited account", async () => {
    const names = `callback({"Message":"","Names":[{"Abn":"51824753556","AbnStatus":"0000000001","IsCurrent":true,"Name":"BELLBIRD LOGISTICS GROUP PTY LTD","NameType":"Entity Name","Postcode":"3000","Score":100,"State":"VIC"}]})`;
    const { fetcher } = fakeFetcher({ "https://abr.business.gov.au/json/MatchingNames.aspx?name=Bellbird%20Logistics&maxResults=10&guid=g&callback=callback": names });
    const [req] = await tdb.db.insert(t.intakeRequests).values({ userId, query: "Bellbird Logistics", country: "AU" }).returning();
    await resolveIntake(tdb.db, fetcher, env, req!.id);
    const [ready] = await tdb.db.select().from(t.intakeRequests).where(eq(t.intakeRequests.id, req!.id));
    expect(ready!.status).toBe("ready");
    expect(ready!.candidates[0]).toMatchObject({ abn: "51824753556" });
    expect(ready!.notes.join(" ")).toMatch(/ASX company list couldn't be searched/);

    const res = await confirmIntake(tdb.db, userId, {
      intakeId: req!.id,
      candidateKey: ready!.candidates[0]!.key,
      accountName: "Bellbird Logistics Group",
      websiteUrl: HOME,
      isKeyAccount: true,
    });
    expect(res.created).toBe(true);
    accountId = res.accountId;
    const [entity] = await tdb.db.select().from(t.entities).where(eq(t.entities.accountId, accountId));
    expect(entity).toMatchObject({ abn: "51824753556", verification: "verified", domain: "bellbird-logistics.example", headquarters: "VIC 3000" });

    // The same ABN again goes to the existing account.
    const [again] = await tdb.db.insert(t.intakeRequests).values({ userId, query: "Bellbird", country: "AU", status: "ready", candidates: ready!.candidates }).returning();
    const dup = await confirmIntake(tdb.db, userId, { intakeId: again!.id, candidateKey: ready!.candidates[0]!.key, accountName: "Bellbird again", isKeyAccount: false });
    expect(dup).toEqual({ accountId, created: false });
  });

  it("runs the full research pipeline and enforces citations, quotes and contact rules", async () => {
    const q = { companyName: "Bellbird Logistics Group", ticker: null, extraTerms: [], region: "AU" as const, days: 90 };
    const { fetcher } = fakeFetcher({
      [ABR_DETAILS]: abrDetails,
      [HOME]: { body: homepage, headers: { "content-type": "text/html" } },
      [LEADERS]: { body: leadership, headers: { "content-type": "text/html" } },
      [googleNewsUrl(q)]: rss,
      [googleNewsUrl(q, "site:afr.com")]: "<rss><channel></channel></rss>",
    });
    const run = await createResearchRun(tdb.db, accountId, userId);
    const done = await runResearch({ db: tdb.db, llm: scriptedModel(), fetcher, env: { ...env, SOURCES_DISABLED: "feeds,austender" } }, run.id);

    expect(done.status).toBe("succeeded");
    const stats = done.stats as { gather: { sources: Record<string, number>; skipped: Record<string, string> }; citations: Record<string, number> };
    expect(stats.gather.sources).toMatchObject({ abn_lookup: 1, web_page: 2, google_news: 1 });
    expect(stats.gather.skipped.web_search).toMatch(/no web search/);
    // [S99] (profile), the made-up quote, and the gmail address are all caught.
    expect(stats.citations.invalidRefs).toBeGreaterThanOrEqual(1);
    expect(stats.citations.droppedQuotes).toBe(1);
    expect(stats.citations.droppedContacts).toBe(1);

    const sections = await tdb.db.select().from(t.briefSections).where(eq(t.briefSections.accountId, accountId));
    expect(sections.map((s) => s.section).sort()).toEqual(["challenges", "licensing_lens", "profile", "services_fit", "stakeholders", "tech_stack"]);
    const profile = sections.find((s) => s.section === "profile")!;
    expect(profile.summaryMd).toMatch(/\[\[src:[0-9a-f-]{36}\]\]/);
    expect(profile.summaryMd).not.toContain("S99");
    expect(profile.promptId).toBe("research.profile");

    const [entity] = await tdb.db.select().from(t.entities).where(eq(t.entities.accountId, accountId));
    expect(entity!.headcount).toBe(2400);

    // Stakeholders: verified with sources, unconfirmed without; quotes only if verbatim.
    const people = await tdb.db.select().from(t.stakeholders).where(eq(t.stakeholders.accountId, accountId));
    const priya = people.find((p) => p.fullName === "Priya Natarajan")!;
    expect(priya.verification).toBe("verified");
    expect(priya.tenureStartedOn).toBe("2022-03-01");
    expect(priya.publicStatements.map((s) => s.text)).toEqual(["Our depots run on data, and data has to be safe."]);
    expect(people.find((p) => p.fullName === "Imaginary Person")!.verification).toBe("unconfirmed");

    // Contacts: published from the page, phone matched on digits, Sam's address inferred from two published ones.
    const contacts = await tdb.db.select({ who: t.stakeholders.fullName, c: t.contactPoints }).from(t.contactPoints).innerJoin(t.stakeholders, eq(t.contactPoints.stakeholderId, t.stakeholders.id));
    const of = (name: string) => contacts.filter((x) => x.who === name).map((x) => `${x.c.kind}:${x.c.value}:${x.c.confidence}`).sort();
    expect(of("Priya Natarajan")).toEqual(["work_email:priya.natarajan@bellbird-logistics.example:published", "work_phone:+61 3 9000 1234:published"]);
    expect(of("Sam Okafor")).toEqual(["work_email:sam.okafor@bellbird-logistics.example:verified_pattern"]);
    expect(contacts.some((x) => x.c.value.includes("gmail"))).toBe(false);

    // Tech stack: website footprint plus model items; an excerpt not in its source is downgraded.
    const stack = await tdb.db.select().from(t.techStackItems).where(eq(t.techStackItems.accountId, accountId));
    expect(stack.map((s) => `${s.vendor}|${s.product}`).sort()).toEqual(["HubSpot|HubSpot", "Microsoft|Entra ID (sign-in)", "Microsoft|Microsoft 365", "SAP|S/4HANA"]);
    expect(stack.find((s) => s.vendor === "SAP")!.confidence).toBe("low");

    // Services fit keeps only real catalogue slugs, and drops matches left with none.
    const fit = sections.find((s) => s.section === "services_fit")!.content as { matches: Array<{ catalogueSlugs: string[] }> };
    expect(fit.matches).toEqual([expect.objectContaining({ catalogueSlugs: ["security-posture-review"] })]);

    const [account] = await tdb.db.select().from(t.accounts).where(eq(t.accounts.id, accountId));
    expect(account!.lastResearchedAt).not.toBeNull();
  });

  it("versions sections on a re-run instead of overwriting", async () => {
    const { fetcher } = fakeFetcher({ [ABR_DETAILS]: abrDetails, [HOME]: homepage });
    const run = await createResearchRun(tdb.db, accountId, userId);
    await runResearch({ db: tdb.db, llm: scriptedModel(), fetcher, env: { ...env, SOURCES_DISABLED: "feeds,austender,google_news" } }, run.id);
    const versions = await tdb.db
      .select({ v: t.briefSections.version })
      .from(t.briefSections)
      .where(and(eq(t.briefSections.accountId, accountId), eq(t.briefSections.section, "profile")));
    expect(versions.map((v) => v.v).sort()).toEqual([1, 2]);
  });

  it("records a partial run when a section fails, and a failed run when nothing can be read", async () => {
    const { fetcher } = fakeFetcher({ [ABR_DETAILS]: abrDetails });
    const partialModel = new MockProvider((req) => {
      if (req.prompt?.id === "research.profile") throw new Error("model unavailable");
      return scripted(req);
    });
    const run = await createResearchRun(tdb.db, accountId, userId);
    const partial = await runResearch({ db: tdb.db, llm: partialModel, fetcher, env: { ...env, SOURCES_DISABLED: "feeds,austender,google_news,web_page" } }, run.id);
    expect(partial.status).toBe("partial");
    expect((partial.stats as { sections: Record<string, string> }).sections.profile).toMatch(/model unavailable/);

    const empty = fakeFetcher({});
    const run2 = await createResearchRun(tdb.db, accountId, userId);
    const failed = await runResearch({ db: tdb.db, llm: scriptedModel(), fetcher: empty.fetcher, env: { SOURCES_DISABLED: "feeds,austender,google_news,web_page" } }, run2.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/No sources could be read/);
  });
});
