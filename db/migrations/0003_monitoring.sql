-- Phase 3: live monitoring, classification output, share prices.

ALTER TABLE signals
  ADD COLUMN why_it_matters text,
  -- The classifier marks items that matched on name but aren't about this company. Hidden, not deleted.
  ADD COLUMN relevant boolean NOT NULL DEFAULT true;

ALTER TABLE accounts ADD COLUMN last_polled_at timestamptz;

CREATE TABLE price_points (
  entity_id   uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  trade_date  date NOT NULL,
  close       numeric(14, 4) NOT NULL CHECK (close >= 0),
  currency    text NOT NULL CHECK (currency IN ('AUD', 'NZD')),
  source_id   uuid NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  PRIMARY KEY (entity_id, trade_date)
);
