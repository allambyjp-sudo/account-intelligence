-- Phase 4: account memory (embeddings) and advisor bookkeeping.

-- Vectors without a fixed dimension, so the embedding model can change (local model, Voyage,
-- whatever Conver offers) without a schema change. Every row records its model; search only
-- compares vectors from the same model. Retrieval is per account (hundreds of rows), so an exact
-- scan is fast and no approximate index is needed.
CREATE TABLE memory_chunks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('note', 'meeting', 'email_summary', 'signal', 'brief_section')),
  ref_id       uuid NOT NULL,
  chunk_index  integer NOT NULL DEFAULT 0 CHECK (chunk_index >= 0),
  text         text NOT NULL CHECK (length(text) > 0),
  model        text NOT NULL,
  embedding    public.vector NOT NULL,
  occurred_at  timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, ref_id, chunk_index, model)
);
CREATE INDEX memory_chunks_account_model_idx ON memory_chunks (account_id, model);

-- When the advisor last ran for an account and what it saw, so it refreshes only when inputs change.
ALTER TABLE accounts ADD COLUMN advisor_fingerprint text, ADD COLUMN advisor_refreshed_at timestamptz;
