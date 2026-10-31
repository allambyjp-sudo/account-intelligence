-- Phase 6: mailbox connections, learned matching rules, and match explanations.

-- A seller's connected mailbox. Tokens are sealed (AES-256-GCM) before they're stored.
CREATE TABLE mail_connections (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider                  text NOT NULL CHECK (provider IN ('graph', 'gmail', 'synthetic')),
  mailbox                   text NOT NULL,
  status                    text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'disconnected')),
  sealed_tokens             text,
  sync_state                jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(sync_state) = 'object'),
  client_state              text NOT NULL DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  subscription_id           text,
  subscription_expires_at   timestamptz,
  last_synced_at            timestamptz,
  last_error                text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider),
  CHECK (provider = 'synthetic' OR status = 'disconnected' OR sealed_tokens IS NOT NULL)
);

-- How email is matched to accounts, beyond entity domains and known contacts. Seller
-- confirmations add 'domain' and 'address' rules (learned = true).
CREATE TABLE email_match_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('domain', 'address', 'partner', 'ignore')),
  pattern     text NOT NULL CHECK (pattern = lower(pattern) AND length(pattern) >= 3),
  account_id  uuid REFERENCES accounts(id) ON DELETE CASCADE,
  learned     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (user_id, kind, pattern, account_id),
  CHECK ((kind IN ('domain', 'address')) = (account_id IS NOT NULL))
);

ALTER TABLE email_threads
  ADD COLUMN match_reason text,
  ADD COLUMN candidate_account_ids uuid[] NOT NULL DEFAULT '{}';
