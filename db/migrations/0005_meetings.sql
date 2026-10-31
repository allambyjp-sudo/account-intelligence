-- Phase 5: meeting prep status.
ALTER TABLE meetings
  ADD COLUMN prep_requested_at timestamptz,
  ADD COLUMN prep_error text;
