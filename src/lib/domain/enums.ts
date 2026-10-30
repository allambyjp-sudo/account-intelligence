/**
 * Every constrained text column in the schema takes its allowed values from here. The SQL
 * migrations repeat them as CHECK constraints, and tests/integration/schema.test.ts fails if the
 * two ever disagree.
 */

/** Whether a claim can be traced to a source. Anything without one is shown as Unconfirmed. */
export const VERIFICATION = ["verified", "unconfirmed"] as const;
export type Verification = (typeof VERIFICATION)[number];

export const CONFIDENCE = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export const IMPORTANCE = ["high", "medium", "low"] as const;
export type Importance = (typeof IMPORTANCE)[number];

export const ACCOUNT_STATUS = ["prospect", "active", "dormant"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUS)[number];

export const COUNTRY = ["AU", "NZ", "OTHER"] as const;
export type Country = (typeof COUNTRY)[number];

export const EXCHANGE = ["ASX", "NZX"] as const;
export type Exchange = (typeof EXCHANGE)[number];

export const SOURCE_TYPE = [
  "registry",
  "announcement",
  "news",
  "tender",
  "job_ad",
  "careers_page",
  "report",
  "advisory",
  "case_study",
  "partner_directory",
  "market_data",
  "web",
  "manual",
] as const;
export type SourceType = (typeof SOURCE_TYPE)[number];

export const STAKEHOLDER_FUNCTION = [
  "executive",
  "cio",
  "cto",
  "ciso",
  "cfo",
  "procurement",
  "infrastructure",
  "data",
  "security",
  "finance",
  "other",
] as const;
export type StakeholderFunction = (typeof STAKEHOLDER_FUNCTION)[number];

export const EMPLOYMENT_STATUS = ["current", "departed", "unknown"] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUS)[number];

/** The seller's read of the relationship. Drives "champion has left or gone quiet" risk flags. */
export const RELATIONSHIP = ["champion", "supporter", "neutral", "detractor", "unknown"] as const;
export type Relationship = (typeof RELATIONSHIP)[number];

/** Professional contact details only. There is deliberately no kind for anything personal. */
export const CONTACT_KIND = ["work_email", "work_phone"] as const;
export type ContactKind = (typeof CONTACT_KIND)[number];

/**
 * Published: the address or number appears on a public page we cite.
 * Verified pattern: the domain's address pattern is confirmed by two or more published addresses.
 * Inferred: a best guess. Never used for phone numbers.
 */
export const CONTACT_CONFIDENCE = ["published", "verified_pattern", "inferred"] as const;
export type ContactConfidence = (typeof CONTACT_CONFIDENCE)[number];

export const SIGNAL_CHANNEL = [
  "news",
  "announcement",
  "tender",
  "hiring",
  "careers_change",
  "share_price",
  "cyber_advisory",
  "manual",
] as const;
export type SignalChannel = (typeof SIGNAL_CHANNEL)[number];

export const SIGNAL_TYPE = [
  "leadership_change",
  "results",
  "cyber_incident",
  "funding_ma",
  "new_tech_role",
  "tender",
  "restructure",
  "other",
  "unclassified",
] as const;
export type SignalType = (typeof SIGNAL_TYPE)[number];

export const BRIEF_SECTION = [
  "profile",
  "stakeholders",
  "tech_stack",
  "challenges",
  "licensing_lens",
  "services_fit",
] as const;
export type BriefSectionKind = (typeof BRIEF_SECTION)[number];

export const TECH_CATEGORY = [
  "productivity",
  "cloud",
  "security",
  "identity",
  "data",
  "network",
  "erp",
  "crm",
  "infrastructure",
  "end_user",
  "devops",
  "other",
] as const;
export type TechCategory = (typeof TECH_CATEGORY)[number];

export const TECH_EVIDENCE = [
  "job_ad",
  "case_study",
  "partner_page",
  "disclosure",
  "web_footprint",
  "announcement",
  "news",
  "seller_note",
  "other",
] as const;
export type TechEvidence = (typeof TECH_EVIDENCE)[number];

export const RECOMMENDATION_KIND = ["next_best_action", "trigger_alert", "talking_point", "risk_flag"] as const;
export type RecommendationKind = (typeof RECOMMENDATION_KIND)[number];

export const RECOMMENDATION_STATUS = ["active", "done", "dismissed", "superseded"] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUS)[number];

export const NOTE_KIND = ["note", "meeting", "outcome", "opportunity", "next_step"] as const;
export type NoteKind = (typeof NOTE_KIND)[number];

export const INPUT_METHOD = ["typed", "voice"] as const;
export type InputMethod = (typeof INPUT_METHOD)[number];

export const EMAIL_PROVIDER = ["graph", "gmail", "synthetic"] as const;
export type EmailProvider = (typeof EMAIL_PROVIDER)[number];

/** Matching order from the brief: sender domain, known contact, partner rule, then the model. */
export const MATCH_METHOD = ["sender_domain", "known_contact", "partner_rule", "llm", "seller"] as const;
export type MatchMethod = (typeof MATCH_METHOD)[number];

export const MATCH_STATUS = ["unmatched", "auto", "pending_confirmation", "confirmed", "rejected"] as const;
export type MatchStatus = (typeof MATCH_STATUS)[number];

export const EMAIL_CLASSIFICATION = [
  "needs_reply",
  "waiting_on_them",
  "quote_or_renewal",
  "deadline_mentioned",
  "info_only",
] as const;
export type EmailClassification = (typeof EMAIL_CLASSIFICATION)[number];

export const ALERT_KIND = ["signal", "quiet_customer", "renewal_window", "champion_change", "advisor_refresh"] as const;
export type AlertKind = (typeof ALERT_KIND)[number];

export const CATALOGUE_KIND = ["service", "vendor_partnership", "case_study"] as const;
export type CatalogueKind = (typeof CATALOGUE_KIND)[number];
