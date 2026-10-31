/**
 * Drizzle mirror of db/migrations/*.sql. The SQL is the source of truth (it carries the CHECK
 * constraints and triggers); this file gives the application typed queries over it.
 * tests/integration/schema.test.ts fails if the two drift apart.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import * as E from "@/lib/domain/enums";

const id = () => uuid("id").primaryKey().defaultRandom();
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
/** pgvector without a fixed dimension (see db/migrations/0004_memory.sql). */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector",
  toDriver: (v) => `[${v.join(",")}]`,
  fromDriver: (v) => (typeof v === "string" ? (JSON.parse(v) as number[]) : (v as unknown as number[])),
});

/** The columns every claim-bearing row carries. */
const claim = () => ({
  sourceId: uuid("source_id").references(() => sources.id, { onDelete: "restrict" }),
  retrievedAt: ts("retrieved_at"),
  verification: text("verification", { enum: E.VERIFICATION }).notNull().default("unconfirmed"),
  confidence: text("confidence", { enum: E.CONFIDENCE }).notNull().default("low"),
});

export const users = pgTable("users", {
  id: id(),
  entraTenantId: text("entra_tenant_id").notNull(),
  entraObjectId: text("entra_object_id").notNull(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  storeEmailBodies: boolean("store_email_bodies").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastSignInAt: ts("last_sign_in_at"),
});

export const accounts = pgTable("accounts", {
  id: id(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status", { enum: E.ACCOUNT_STATUS }).notNull().default("prospect"),
  isKeyAccount: boolean("is_key_account").notNull().default(false),
  isFictional: boolean("is_fictional").notNull().default(false),
  emailExcluded: boolean("email_excluded").notNull().default(false),
  emailExcludedReason: text("email_excluded_reason"),
  quietAfterDays: integer("quiet_after_days").notNull().default(30),
  lastContactAt: ts("last_contact_at"),
  lastResearchedAt: ts("last_researched_at"),
  lastViewedAt: ts("last_viewed_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  websiteUrl: text("website_url"),
  careersUrl: text("careers_url"),
  reportUrls: text("report_urls").array().notNull().default(sql`'{}'`),
  newsTerms: text("news_terms").array().notNull().default(sql`'{}'`),
  lastPolledAt: ts("last_polled_at"),
  advisorFingerprint: text("advisor_fingerprint"),
  advisorRefreshedAt: ts("advisor_refreshed_at"),
});

export const sources = pgTable("sources", {
  id: id(),
  url: text("url").notNull(),
  title: text("title"),
  publisher: text("publisher"),
  adapter: text("adapter").notNull(),
  sourceType: text("source_type", { enum: E.SOURCE_TYPE }).notNull(),
  publishedAt: ts("published_at"),
  retrievedAt: ts("retrieved_at").notNull().defaultNow(),
  contentHash: text("content_hash"),
  excerpt: text("excerpt"),
  bodyText: text("body_text"),
});

export const entities = pgTable("entities", {
  id: id(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  parentEntityId: uuid("parent_entity_id"),
  legalName: text("legal_name").notNull(),
  country: text("country", { enum: E.COUNTRY }).notNull(),
  abn: text("abn"),
  acn: text("acn"),
  nzbn: text("nzbn"),
  domain: text("domain"),
  exchange: text("exchange", { enum: E.EXCHANGE }),
  ticker: text("ticker"),
  industry: text("industry"),
  headcount: integer("headcount"),
  headquarters: text("headquarters"),
  isPrimary: boolean("is_primary").notNull().default(false),
  ...claim(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export interface PriorRole {
  organisation: string;
  title: string;
  from?: string;
  to?: string;
  sourceId?: string;
}
export interface PublicStatement {
  text: string;
  sourceId: string;
  saidOn?: string;
}

export const stakeholders = pgTable("stakeholders", {
  id: id(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  entityId: uuid("entity_id").references(() => entities.id, { onDelete: "set null" }),
  fullName: text("full_name").notNull(),
  title: text("title").notNull(),
  function: text("function", { enum: E.STAKEHOLDER_FUNCTION }).notNull(),
  tenureStartedOn: date("tenure_started_on"),
  priorRoles: jsonb("prior_roles").$type<PriorRole[]>().notNull().default([]),
  publicStatements: jsonb("public_statements").$type<PublicStatement[]>().notNull().default([]),
  employmentStatus: text("employment_status", { enum: E.EMPLOYMENT_STATUS }).notNull().default("current"),
  relationship: text("relationship", { enum: E.RELATIONSHIP }).notNull().default("unknown"),
  lastContactedAt: ts("last_contacted_at"),
  ...claim(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const contactPoints = pgTable("contact_points", {
  id: id(),
  stakeholderId: uuid("stakeholder_id")
    .notNull()
    .references(() => stakeholders.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: E.CONTACT_KIND }).notNull(),
  value: text("value").notNull(),
  confidence: text("confidence", { enum: E.CONTACT_CONFIDENCE }).notNull(),
  pattern: text("pattern"),
  sourceId: uuid("source_id").references(() => sources.id, { onDelete: "restrict" }),
  retrievedAt: ts("retrieved_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const techStackItems = pgTable("tech_stack_items", {
  id: id(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  vendor: text("vendor").notNull(),
  product: text("product").notNull(),
  category: text("category", { enum: E.TECH_CATEGORY }).notNull(),
  evidenceKind: text("evidence_kind", { enum: E.TECH_EVIDENCE }).notNull(),
  evidenceExcerpt: text("evidence_excerpt"),
  firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  ...claim(),
});

export const briefSections = pgTable("brief_sections", {
  id: id(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  section: text("section", { enum: E.BRIEF_SECTION }).notNull(),
  version: integer("version").notNull(),
  content: jsonb("content").$type<unknown>().notNull(),
  summaryMd: text("summary_md").notNull(),
  sourceIds: uuid("source_ids").array().notNull().default(sql`'{}'`),
  promptId: text("prompt_id").notNull(),
  promptVersion: integer("prompt_version").notNull(),
  model: text("model").notNull(),
  generatedAt: ts("generated_at").notNull().defaultNow(),
});

export const signals = pgTable("signals", {
  id: id(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  sourceId: uuid("source_id")
    .notNull()
    .references(() => sources.id, { onDelete: "restrict" }),
  channel: text("channel", { enum: E.SIGNAL_CHANNEL }).notNull(),
  signalType: text("signal_type", { enum: E.SIGNAL_TYPE }).notNull().default("unclassified"),
  importance: text("importance", { enum: E.IMPORTANCE }),
  title: text("title").notNull(),
  summary: text("summary"),
  occurredAt: ts("occurred_at").notNull(),
  detectedAt: ts("detected_at").notNull().defaultNow(),
  classifiedAt: ts("classified_at"),
  classifier: text("classifier"),
  dedupeKey: text("dedupe_key").notNull(),
  whyItMatters: text("why_it_matters"),
  relevant: boolean("relevant").notNull().default(true),
});

export const pricePoints = pgTable("price_points", {
  entityId: uuid("entity_id")
    .notNull()
    .references(() => entities.id, { onDelete: "cascade" }),
  tradeDate: date("trade_date").notNull(),
  close: numeric("close", { precision: 14, scale: 4 }).notNull(),
  currency: text("currency", { enum: ["AUD", "NZD"] }).notNull(),
  sourceId: uuid("source_id")
    .notNull()
    .references(() => sources.id, { onDelete: "restrict" }),
});

/** What a recommendation rests on. At least one is required (enforced in SQL). */
export type EvidenceRef =
  | { kind: "source"; sourceId: string }
  | { kind: "signal"; signalId: string }
  | { kind: "note"; noteId: string }
  | { kind: "email"; threadId: string };

export const recommendations = pgTable("recommendations", {
  id: id(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: E.RECOMMENDATION_KIND }).notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  targetStakeholderId: uuid("target_stakeholder_id").references(() => stakeholders.id, { onDelete: "set null" }),
  evidence: jsonb("evidence").$type<EvidenceRef[]>().notNull(),
  status: text("status", { enum: E.RECOMMENDATION_STATUS }).notNull().default("active"),
  inputFingerprint: text("input_fingerprint").notNull(),
  promptId: text("prompt_id").notNull(),
  promptVersion: integer("prompt_version").notNull(),
  model: text("model").notNull(),
  generatedAt: ts("generated_at").notNull().defaultNow(),
});

export const alerts = pgTable("alerts", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  signalId: uuid("signal_id").references(() => signals.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: E.ALERT_KIND }).notNull(),
  importance: text("importance", { enum: E.IMPORTANCE }).notNull(),
  title: text("title").notNull(),
  body: text("body"),
  createdAt: ts("created_at").notNull().defaultNow(),
  readAt: ts("read_at"),
  dismissedAt: ts("dismissed_at"),
});

export const notes = pgTable("notes", {
  id: id(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  authorUserId: uuid("author_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: E.NOTE_KIND }).notNull(),
  body: text("body").notNull(),
  inputMethod: text("input_method", { enum: E.INPUT_METHOD }).notNull().default("typed"),
  occurredAt: ts("occurred_at").notNull().defaultNow(),
  dueOn: date("due_on"),
  completedAt: ts("completed_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const meetings = pgTable("meetings", {
  id: id(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  scheduledFor: ts("scheduled_for"),
  attendeeStakeholderIds: uuid("attendee_stakeholder_ids").array().notNull().default(sql`'{}'`),
  otherAttendees: jsonb("other_attendees").$type<{ name: string; role?: string }[]>().notNull().default([]),
  prep: jsonb("prep").$type<unknown>(),
  prepGeneratedAt: ts("prep_generated_at"),
  prepRequestedAt: ts("prep_requested_at"),
  prepError: text("prep_error"),
  promptId: text("prompt_id"),
  promptVersion: integer("prompt_version"),
  model: text("model"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export interface EmailParticipant {
  address: string;
  name?: string;
  role: "from" | "to" | "cc";
}

export const emailThreads = pgTable("email_threads", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: E.EMAIL_PROVIDER }).notNull(),
  providerThreadId: text("provider_thread_id").notNull(),
  subject: text("subject").notNull(),
  participants: jsonb("participants").$type<EmailParticipant[]>().notNull().default([]),
  firstMessageAt: ts("first_message_at").notNull(),
  lastMessageAt: ts("last_message_at").notNull(),
  lastInboundAt: ts("last_inbound_at"),
  lastOutboundAt: ts("last_outbound_at"),
  matchMethod: text("match_method", { enum: E.MATCH_METHOD }),
  matchConfidence: numeric("match_confidence", { precision: 4, scale: 3 }),
  matchStatus: text("match_status", { enum: E.MATCH_STATUS }).notNull().default("unmatched"),
  classification: text("classification", { enum: E.EMAIL_CLASSIFICATION }),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const emailSummaries = pgTable("email_summaries", {
  id: id(),
  threadId: uuid("thread_id")
    .notNull()
    .references(() => emailThreads.id, { onDelete: "cascade" }),
  providerMessageId: text("provider_message_id").notNull(),
  summary: text("summary").notNull(),
  deadlines: jsonb("deadlines").$type<{ date: string; what: string }[]>().notNull().default([]),
  actionItems: jsonb("action_items").$type<{ owner: "us" | "them"; what: string }[]>().notNull().default([]),
  bodyText: text("body_text"),
  promptId: text("prompt_id").notNull(),
  promptVersion: integer("prompt_version").notNull(),
  model: text("model").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const servicesCatalogueItems = pgTable("services_catalogue_items", {
  id: id(),
  slug: text("slug").notNull().unique(),
  kind: text("kind", { enum: E.CATALOGUE_KIND }).notNull(),
  name: text("name").notNull(),
  summary: text("summary").notNull(),
  painPoints: text("pain_points").array().notNull().default(sql`'{}'`),
  vendors: text("vendors").array().notNull().default(sql`'{}'`),
  keywords: text("keywords").array().notNull().default(sql`'{}'`),
  url: text("url"),
  isPlaceholder: boolean("is_placeholder").notNull().default(false),
  active: boolean("active").notNull().default(true),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const memoryChunks = pgTable("memory_chunks", {
  id: id(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: E.MEMORY_KIND }).notNull(),
  refId: uuid("ref_id").notNull(),
  chunkIndex: integer("chunk_index").notNull().default(0),
  text: text("text").notNull(),
  model: text("model").notNull(),
  embedding: vector("embedding").notNull(),
  occurredAt: ts("occurred_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const httpCache = pgTable("http_cache", {
  cacheKey: text("cache_key").primaryKey(),
  url: text("url").notNull(),
  status: integer("status").notNull(),
  headers: jsonb("headers").$type<Record<string, string>>().notNull(),
  body: bytea("body").notNull(),
  etag: text("etag"),
  lastModified: text("last_modified"),
  fetchedAt: ts("fetched_at").notNull(),
  expiresAt: ts("expires_at").notNull(),
});

export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  startedAt: ts("started_at").notNull(),
  lastBeatAt: ts("last_beat_at").notNull(),
  version: text("version").notNull(),
});

/** A registry match offered to the seller on the intake picker. */
export interface IntakeCandidate {
  key: string;
  legalName: string;
  country: "AU" | "NZ";
  abn?: string;
  acn?: string;
  nzbn?: string;
  entityType?: string;
  status?: string;
  state?: string;
  postcode?: string;
  exchange?: "ASX" | "NZX";
  ticker?: string;
  industry?: string;
  score: number;
  /** Public page a person can open to check the record. Never an API URL (those can carry keys). */
  sourceUrl: string;
  adapter: string;
}

export const intakeRequests = pgTable("intake_requests", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  query: text("query").notNull(),
  country: text("country", { enum: E.INTAKE_COUNTRY }).notNull(),
  status: text("status", { enum: E.INTAKE_STATUS }).notNull().default("resolving"),
  candidates: jsonb("candidates").$type<IntakeCandidate[]>().notNull().default([]),
  notes: jsonb("notes").$type<string[]>().notNull().default([]),
  accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const researchRuns = pgTable("research_runs", {
  id: id(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
  status: text("status", { enum: E.RESEARCH_STATUS }).notNull().default("queued"),
  stage: text("stage"),
  stats: jsonb("stats").$type<Record<string, unknown>>().notNull().default({}),
  usage: jsonb("usage").$type<Record<string, number>>().notNull().default({}),
  error: text("error"),
  createdAt: ts("created_at").notNull().defaultNow(),
  startedAt: ts("started_at"),
  finishedAt: ts("finished_at"),
});

export type User = typeof users.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Source = typeof sources.$inferSelect;
export type Entity = typeof entities.$inferSelect;
export type Stakeholder = typeof stakeholders.$inferSelect;
export type ContactPoint = typeof contactPoints.$inferSelect;
export type TechStackItem = typeof techStackItems.$inferSelect;
export type BriefSection = typeof briefSections.$inferSelect;
export type Signal = typeof signals.$inferSelect;
export type Recommendation = typeof recommendations.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type Meeting = typeof meetings.$inferSelect;
export type EmailThread = typeof emailThreads.$inferSelect;
export type EmailSummary = typeof emailSummaries.$inferSelect;
export type ServicesCatalogueItem = typeof servicesCatalogueItems.$inferSelect;
export type IntakeRequest = typeof intakeRequests.$inferSelect;
export type PricePoint = typeof pricePoints.$inferSelect;
export type MemoryChunk = typeof memoryChunks.$inferSelect;
export type ResearchRun = typeof researchRuns.$inferSelect;
