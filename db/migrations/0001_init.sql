-- Account Intelligence Platform: initial schema.
--
-- Rules the database enforces, so a bug in application code can't break them:
--   * Everything cited. A claim can only be 'verified' when it names a source and a retrieval time.
--     Anything else is 'unconfirmed' and the UI labels it so.
--   * Professional contacts only. contact_points.kind allows a work email or a work phone, nothing
--     else. Phone numbers must be published; they are never inferred.
--   * Every recommendation links to at least one piece of evidence.
--   * Accounts excluded from email ingestion can never have email stored against them (trigger).
--   * Seller-owned rows hang off accounts.id, so deleting an account removes its memory, email and signals.
--
-- Constrained text columns take their values from src/lib/domain/enums.ts. Keep the two in step;
-- tests/integration/schema.test.ts checks them.

-- Explicitly in public: otherwise it lands in whichever schema is first on the search path.
CREATE EXTENSION IF NOT EXISTS vector SCHEMA public;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- People and accounts
-- ---------------------------------------------------------------------------------------------

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entra_tenant_id     text NOT NULL,
  entra_object_id     text NOT NULL,
  email               text NOT NULL,
  display_name        text NOT NULL,
  store_email_bodies  boolean NOT NULL DEFAULT false, -- summaries and metadata only, unless the seller opts in
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at     timestamptz,
  UNIQUE (entra_tenant_id, entra_object_id)
);

CREATE TABLE accounts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                    text NOT NULL,
  status                  text NOT NULL DEFAULT 'prospect' CHECK (status IN ('prospect', 'active', 'dormant')),
  is_key_account          boolean NOT NULL DEFAULT false,
  is_fictional            boolean NOT NULL DEFAULT false,
  email_excluded          boolean NOT NULL DEFAULT false,
  email_excluded_reason   text,
  quiet_after_days        integer NOT NULL DEFAULT 30 CHECK (quiet_after_days > 0),
  last_contact_at         timestamptz,
  last_researched_at      timestamptz,
  last_viewed_at          timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, name),
  CHECK (email_excluded OR email_excluded_reason IS NULL)
);
CREATE TRIGGER accounts_updated_at BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Sources: every cited claim points at one of these
-- ---------------------------------------------------------------------------------------------

CREATE TABLE sources (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url            text NOT NULL CHECK (url ~ '^https?://'),
  title          text,
  publisher      text,
  adapter        text NOT NULL, -- which source adapter produced it, e.g. 'asx_announcements', 'web_search', 'manual'
  source_type    text NOT NULL CHECK (source_type IN ('registry', 'announcement', 'news', 'tender', 'job_ad', 'careers_page', 'report', 'advisory', 'case_study', 'partner_directory', 'market_data', 'web', 'manual')),
  published_at   timestamptz,
  retrieved_at   timestamptz NOT NULL DEFAULT now(),
  content_hash   text, -- lets careers-page change detection keep one row per distinct version
  excerpt        text,
  UNIQUE NULLS NOT DISTINCT (url, content_hash)
);
CREATE INDEX sources_url_idx ON sources (url);

-- ---------------------------------------------------------------------------------------------
-- The static brief
-- ---------------------------------------------------------------------------------------------

CREATE TABLE entities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  parent_entity_id  uuid REFERENCES entities(id) ON DELETE SET NULL,
  legal_name        text NOT NULL,
  country           text NOT NULL CHECK (country IN ('AU', 'NZ', 'OTHER')),
  abn               text CHECK (abn ~ '^[0-9]{11}$'),
  acn               text CHECK (acn ~ '^[0-9]{9}$'),
  nzbn              text CHECK (nzbn ~ '^[0-9]{13}$'),
  domain            text CHECK (domain ~ '^[a-z0-9.-]+$'),
  exchange          text CHECK (exchange IN ('ASX', 'NZX')),
  ticker            text CHECK (ticker ~ '^[A-Z0-9]{1,6}$'),
  industry          text,
  headcount         integer CHECK (headcount >= 0),
  is_primary        boolean NOT NULL DEFAULT false,
  source_id         uuid REFERENCES sources(id) ON DELETE RESTRICT,
  retrieved_at      timestamptz,
  verification      text NOT NULL DEFAULT 'unconfirmed' CHECK (verification IN ('verified', 'unconfirmed')),
  confidence        text NOT NULL DEFAULT 'low' CHECK (confidence IN ('high', 'medium', 'low')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((exchange IS NULL) = (ticker IS NULL)),
  CHECK (verification = 'unconfirmed' OR (source_id IS NOT NULL AND retrieved_at IS NOT NULL))
);
CREATE UNIQUE INDEX entities_one_primary_per_account ON entities (account_id) WHERE is_primary;
CREATE INDEX entities_account_idx ON entities (account_id);

CREATE TABLE stakeholders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  entity_id           uuid REFERENCES entities(id) ON DELETE SET NULL,
  full_name           text NOT NULL,
  title               text NOT NULL,
  function            text NOT NULL CHECK (function IN ('executive', 'cio', 'cto', 'ciso', 'cfo', 'procurement', 'infrastructure', 'data', 'security', 'finance', 'other')),
  tenure_started_on   date,
  prior_roles         jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(prior_roles) = 'array'),
  public_statements   jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(public_statements) = 'array'), -- [{text, sourceId, saidOn}]
  employment_status   text NOT NULL DEFAULT 'current' CHECK (employment_status IN ('current', 'departed', 'unknown')),
  relationship        text NOT NULL DEFAULT 'unknown' CHECK (relationship IN ('champion', 'supporter', 'neutral', 'detractor', 'unknown')),
  last_contacted_at   timestamptz,
  source_id           uuid REFERENCES sources(id) ON DELETE RESTRICT,
  retrieved_at        timestamptz,
  verification        text NOT NULL DEFAULT 'unconfirmed' CHECK (verification IN ('verified', 'unconfirmed')),
  confidence          text NOT NULL DEFAULT 'low' CHECK (confidence IN ('high', 'medium', 'low')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (verification = 'unconfirmed' OR (source_id IS NOT NULL AND retrieved_at IS NOT NULL))
);
CREATE INDEX stakeholders_account_idx ON stakeholders (account_id);
CREATE TRIGGER stakeholders_updated_at BEFORE UPDATE ON stakeholders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE contact_points (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stakeholder_id  uuid NOT NULL REFERENCES stakeholders(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('work_email', 'work_phone')),
  value           text NOT NULL,
  confidence      text NOT NULL CHECK (confidence IN ('published', 'verified_pattern', 'inferred')),
  pattern         text, -- e.g. '{first}.{last}@example.com' for pattern-derived addresses
  source_id       uuid REFERENCES sources(id) ON DELETE RESTRICT,
  retrieved_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stakeholder_id, kind, value),
  CHECK (confidence <> 'published' OR (source_id IS NOT NULL AND retrieved_at IS NOT NULL)),
  CHECK (confidence <> 'verified_pattern' OR pattern IS NOT NULL),
  CHECK (kind = 'work_email' OR confidence = 'published'),
  CHECK (kind <> 'work_email' OR value ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);
CREATE INDEX contact_points_stakeholder_idx ON contact_points (stakeholder_id);

CREATE TABLE tech_stack_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  vendor            text NOT NULL,
  product           text NOT NULL,
  category          text NOT NULL CHECK (category IN ('productivity', 'cloud', 'security', 'identity', 'data', 'network', 'erp', 'crm', 'infrastructure', 'end_user', 'devops', 'other')),
  evidence_kind     text NOT NULL CHECK (evidence_kind IN ('job_ad', 'case_study', 'partner_page', 'disclosure', 'web_footprint', 'announcement', 'news', 'seller_note', 'other')),
  evidence_excerpt  text,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  source_id         uuid REFERENCES sources(id) ON DELETE RESTRICT,
  retrieved_at      timestamptz,
  verification      text NOT NULL DEFAULT 'unconfirmed' CHECK (verification IN ('verified', 'unconfirmed')),
  confidence        text NOT NULL DEFAULT 'low' CHECK (confidence IN ('high', 'medium', 'low')),
  UNIQUE (account_id, vendor, product),
  CHECK (verification = 'unconfirmed' OR (source_id IS NOT NULL AND retrieved_at IS NOT NULL))
);

CREATE TABLE brief_sections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  section         text NOT NULL CHECK (section IN ('profile', 'stakeholders', 'tech_stack', 'challenges', 'licensing_lens', 'services_fit')),
  version         integer NOT NULL CHECK (version > 0),
  content         jsonb NOT NULL, -- structured output; claims inside it reference sources by id
  summary_md      text NOT NULL,
  source_ids      uuid[] NOT NULL DEFAULT '{}',
  prompt_id       text NOT NULL,
  prompt_version  integer NOT NULL,
  model           text NOT NULL,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, section, version)
);

-- ---------------------------------------------------------------------------------------------
-- Live monitoring and the advisor
-- ---------------------------------------------------------------------------------------------

CREATE TABLE signals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_id      uuid NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  channel        text NOT NULL CHECK (channel IN ('news', 'announcement', 'tender', 'hiring', 'careers_change', 'share_price', 'cyber_advisory', 'manual')),
  signal_type    text NOT NULL DEFAULT 'unclassified' CHECK (signal_type IN ('leadership_change', 'results', 'cyber_incident', 'funding_ma', 'new_tech_role', 'tender', 'restructure', 'other', 'unclassified')),
  importance     text CHECK (importance IN ('high', 'medium', 'low')),
  title          text NOT NULL,
  summary        text,
  occurred_at    timestamptz NOT NULL,
  detected_at    timestamptz NOT NULL DEFAULT now(),
  classified_at  timestamptz,
  classifier     text, -- prompt id@version and model
  dedupe_key     text NOT NULL,
  UNIQUE (account_id, dedupe_key),
  CHECK ((signal_type = 'unclassified') = (classified_at IS NULL)),
  CHECK (classified_at IS NULL OR (importance IS NOT NULL AND classifier IS NOT NULL))
);
CREATE INDEX signals_account_time_idx ON signals (account_id, occurred_at DESC);

CREATE TABLE recommendations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind                   text NOT NULL CHECK (kind IN ('next_best_action', 'trigger_alert', 'talking_point', 'risk_flag')),
  title                  text NOT NULL,
  body                   text NOT NULL,
  target_stakeholder_id  uuid REFERENCES stakeholders(id) ON DELETE SET NULL,
  evidence               jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) > 0),
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'dismissed', 'superseded')),
  input_fingerprint      text NOT NULL, -- hash of the advisor's inputs; it only refreshes when this changes
  prompt_id              text NOT NULL,
  prompt_version         integer NOT NULL,
  model                  text NOT NULL,
  generated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recommendations_active_idx ON recommendations (account_id) WHERE status = 'active';

CREATE TABLE alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  signal_id     uuid REFERENCES signals(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('signal', 'quiet_customer', 'renewal_window', 'champion_change', 'advisor_refresh')),
  importance    text NOT NULL CHECK (importance IN ('high', 'medium', 'low')),
  title         text NOT NULL,
  body          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz,
  dismissed_at  timestamptz,
  CHECK (kind <> 'signal' OR signal_id IS NOT NULL)
);
CREATE INDEX alerts_open_idx ON alerts (user_id, account_id) WHERE dismissed_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Account memory
-- ---------------------------------------------------------------------------------------------

CREATE TABLE notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  author_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('note', 'meeting', 'outcome', 'opportunity', 'next_step')),
  body            text NOT NULL CHECK (length(body) > 0),
  input_method    text NOT NULL DEFAULT 'typed' CHECK (input_method IN ('typed', 'voice')),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  due_on          date,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notes_account_time_idx ON notes (account_id, occurred_at DESC);
CREATE TRIGGER notes_updated_at BEFORE UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE meetings (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by                uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                     text NOT NULL,
  scheduled_for             timestamptz,
  attendee_stakeholder_ids  uuid[] NOT NULL DEFAULT '{}',
  other_attendees           jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(other_attendees) = 'array'),
  prep                      jsonb,
  prep_generated_at         timestamptz,
  prompt_id                 text,
  prompt_version            integer,
  model                     text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CHECK ((prep IS NULL) = (prep_generated_at IS NULL)),
  CHECK (prep IS NULL OR (prompt_id IS NOT NULL AND prompt_version IS NOT NULL AND model IS NOT NULL))
);

-- ---------------------------------------------------------------------------------------------
-- Email
-- ---------------------------------------------------------------------------------------------

CREATE TABLE email_threads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- the mailbox owner
  account_id          uuid REFERENCES accounts(id) ON DELETE CASCADE,
  provider            text NOT NULL CHECK (provider IN ('graph', 'gmail', 'synthetic')),
  provider_thread_id  text NOT NULL,
  subject             text NOT NULL,
  participants        jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(participants) = 'array'),
  first_message_at    timestamptz NOT NULL,
  last_message_at     timestamptz NOT NULL,
  last_inbound_at     timestamptz,
  last_outbound_at    timestamptz,
  match_method        text CHECK (match_method IN ('sender_domain', 'known_contact', 'partner_rule', 'llm', 'seller')),
  match_confidence    numeric(4, 3) CHECK (match_confidence BETWEEN 0 AND 1),
  match_status        text NOT NULL DEFAULT 'unmatched' CHECK (match_status IN ('unmatched', 'auto', 'pending_confirmation', 'confirmed', 'rejected')),
  classification      text CHECK (classification IN ('needs_reply', 'waiting_on_them', 'quote_or_renewal', 'deadline_mentioned', 'info_only')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, provider_thread_id),
  CHECK (match_status IN ('unmatched', 'rejected') OR account_id IS NOT NULL),
  CHECK (account_id IS NULL OR match_method IS NOT NULL)
);
CREATE INDEX email_threads_account_time_idx ON email_threads (account_id, last_message_at DESC);
CREATE TRIGGER email_threads_updated_at BEFORE UPDATE ON email_threads FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE email_summaries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id            uuid NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE,
  provider_message_id  text NOT NULL,
  summary              text NOT NULL,
  deadlines            jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(deadlines) = 'array'),
  action_items         jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(action_items) = 'array'),
  body_text            text, -- only when the mailbox owner has opted in (users.store_email_bodies)
  prompt_id            text NOT NULL,
  prompt_version       integer NOT NULL,
  model                text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (thread_id, provider_message_id)
);

-- Per-account exclusion: sensitive or government accounts opt out of email entirely. Enforced here
-- so that no ingestion bug can store mail against an excluded account.
CREATE OR REPLACE FUNCTION reject_email_for_excluded_account() RETURNS trigger AS $$
BEGIN
  IF NEW.account_id IS NOT NULL AND EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND email_excluded) THEN
    RAISE EXCEPTION 'account % is excluded from email ingestion', NEW.account_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER email_threads_respect_exclusion BEFORE INSERT OR UPDATE OF account_id ON email_threads
  FOR EACH ROW EXECUTE FUNCTION reject_email_for_excluded_account();

-- Excluding an account later removes the email already stored against it.
CREATE OR REPLACE FUNCTION purge_email_on_exclusion() RETURNS trigger AS $$
BEGIN
  IF NEW.email_excluded AND NOT OLD.email_excluded THEN
    DELETE FROM email_threads WHERE account_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER accounts_purge_email_on_exclusion AFTER UPDATE OF email_excluded ON accounts
  FOR EACH ROW EXECUTE FUNCTION purge_email_on_exclusion();

-- ---------------------------------------------------------------------------------------------
-- Services catalogue (maintained by hand in data/services-catalogue.json)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE services_catalogue_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  kind            text NOT NULL CHECK (kind IN ('service', 'vendor_partnership', 'case_study')),
  name            text NOT NULL,
  summary         text NOT NULL,
  pain_points     text[] NOT NULL DEFAULT '{}',
  vendors         text[] NOT NULL DEFAULT '{}',
  keywords        text[] NOT NULL DEFAULT '{}',
  url             text CHECK (url ~ '^https?://'),
  is_placeholder  boolean NOT NULL DEFAULT false,
  active          boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER services_catalogue_items_updated_at BEFORE UPDATE ON services_catalogue_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Infrastructure
-- ---------------------------------------------------------------------------------------------

-- Response cache for every external source (see src/lib/http). Keyed by method and URL.
CREATE TABLE http_cache (
  cache_key      text PRIMARY KEY,
  url            text NOT NULL,
  status         integer NOT NULL,
  headers        jsonb NOT NULL,
  body           bytea NOT NULL,
  etag           text,
  last_modified  text,
  fetched_at     timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL
);
CREATE INDEX http_cache_expires_idx ON http_cache (expires_at);

CREATE TABLE worker_heartbeats (
  worker_id     text PRIMARY KEY,
  started_at    timestamptz NOT NULL,
  last_beat_at  timestamptz NOT NULL,
  version       text NOT NULL
);
