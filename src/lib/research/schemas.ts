import { z } from "zod";
import { CONFIDENCE, STAKEHOLDER_FUNCTION, TECH_CATEGORY, TECH_EVIDENCE } from "@/lib/domain/enums";

/**
 * What the model returns for each brief section. Kept to plain types (no length or pattern limits)
 * so every provider's structured-output mode can follow them; code validates the rest afterwards.
 */
const refs = z.array(z.string()).describe('Source refs that support this, like "S3". Empty when no source supports it.');
const confidence = z.enum(CONFIDENCE);
const claim = z.object({ text: z.string(), sources: refs, confidence });
const summary = z.string().describe("A short readable summary for a seller. Put [S#] markers straight after each sourced statement.");

export const profileOutput = z.object({
  summary,
  overview: claim,
  industry: z.string().nullable(),
  headquarters: claim.nullable(),
  headcount: z.object({ value: z.number().nullable(), basis: claim }).nullable(),
  financials: z.array(claim).describe("Revenue, profit, market cap or funding, each with its period."),
  ownership: claim.nullable(),
  subsidiaries: z.array(z.object({ name: z.string(), claim })),
  history: z.array(z.object({ when: z.string(), claim })).describe("Key dates, oldest first."),
});

export const stakeholdersOutput = z.object({
  summary,
  people: z.array(
    z.object({
      fullName: z.string(),
      title: z.string(),
      function: z.enum(STAKEHOLDER_FUNCTION),
      tenureStartedOn: z.string().nullable().describe("YYYY-MM-DD or YYYY-MM when a source gives it."),
      priorRoles: z.array(z.object({ organisation: z.string(), title: z.string(), from: z.string().nullable(), to: z.string().nullable() })),
      statements: z.array(z.object({ quote: z.string().describe("Copied exactly from the source."), source: z.string(), saidOn: z.string().nullable() })),
      workEmails: z.array(z.object({ address: z.string(), source: z.string() })).describe("Only addresses printed exactly in a source."),
      workPhones: z.array(z.object({ number: z.string(), source: z.string() })).describe("Only business numbers printed exactly in a source."),
      sources: refs,
      confidence,
    }),
  ),
});

export const techStackOutput = z.object({
  summary,
  items: z.array(
    z.object({
      vendor: z.string(),
      product: z.string(),
      category: z.enum(TECH_CATEGORY),
      evidenceKind: z.enum(TECH_EVIDENCE),
      evidenceExcerpt: z.string().describe("The words in the source that point to this product."),
      sources: refs,
      confidence,
    }),
  ),
});

export const challengesOutput = z.object({
  summary,
  challenges: z.array(claim),
  opportunities: z.array(claim),
});

export const licensingOutput = z.object({
  summary,
  eaRenewal: z.object({
    estimate: z.string().nullable().describe('Your best estimate of the Microsoft agreement renewal window, e.g. "Likely around mid-2027", or null.'),
    reasoning: claim,
  }),
  vendorFootprint: z.array(z.object({ vendor: z.string(), products: z.array(z.string()), claim })),
  openings: z.array(claim).describe("Optimisation or consolidation openings, each grounded in evidence."),
});

export const servicesFitOutput = z.object({
  summary,
  matches: z.array(
    z.object({
      painPoint: claim,
      catalogueSlugs: z.array(z.string()).describe("Slugs from the services catalogue, and only those."),
      rationale: z.string(),
    }),
  ),
});

export type ProfileOutput = z.infer<typeof profileOutput>;
export type StakeholdersOutput = z.infer<typeof stakeholdersOutput>;
export type TechStackOutput = z.infer<typeof techStackOutput>;
export type ChallengesOutput = z.infer<typeof challengesOutput>;
export type LicensingOutput = z.infer<typeof licensingOutput>;
export type ServicesFitOutput = z.infer<typeof servicesFitOutput>;
