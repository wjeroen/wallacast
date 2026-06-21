-- Migration 021: store the error message when summary generation fails.
-- Surfaced on library cards (with a Retry button) so summary failures are visible in-app
-- instead of only in the Railway logs.
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS summary_error TEXT DEFAULT NULL;
