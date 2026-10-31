-- Phase 2: intake, source text, research runs, per-account monitoring settings.

-- The text the model reads. Capped in the application (see src/lib/sources/store.ts).
ALTER TABLE sources ADD COLUMN body_text text;

-- Where to look for this account beyond the registries and news.
ALTER TABLE accounts
  ADD COLUMN website_url  text CHECK (website_url ~ '^https?://'),
  ADD COLUMN careers_url  text CHECK (careers_url ~ '^https?://'),
  ADD COLUMN report_urls  text[] NOT NULL DEFAULT '{}',
  ADD COLUMN news_terms   text[] NOT NULL DEFAULT '{}';

ALTER TABLE entities ADD COLUMN headquarters text;

-- A seller typing a company name. A worker job resolves it to registry candidates; the seller
-- picks one (or enters details by hand) and the account is created from that.
CREATE TABLE intake_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query        text NOT NULL CHECK (length(query) BETWEEN 2 AND 200),
  country      text NOT NULL CHECK (country IN ('AU', 'NZ', 'ANY')),
  status       text NOT NULL DEFAULT 'resolving' CHECK (status IN ('resolving', 'ready', 'failed', 'completed')),
  candidates   jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(candidates) = 'array'),
  notes        jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(notes) = 'array'), -- per-source problems, shown to the seller
  account_id   uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX intake_requests_user_idx ON intake_requests (user_id, created_at DESC);
CREATE TRIGGER intake_requests_updated_at BEFORE UPDATE ON intake_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One research agent run: what it gathered, what it cost, and how it ended.
CREATE TABLE research_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  requested_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed')),
  stage         text,
  stats         jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(stats) = 'object'),
  usage         jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(usage) = 'object'),
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  CHECK (status NOT IN ('succeeded', 'partial', 'failed') OR finished_at IS NOT NULL)
);
CREATE INDEX research_runs_account_idx ON research_runs (account_id, created_at DESC);
