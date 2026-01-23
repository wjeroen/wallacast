-- Migration: Optimize playback position updates
-- Problem: Frequent playback updates were slow (~900ms) due to:
--   1. updated_at being set unnecessarily (fixed in code)
--   2. Missing composite index for WHERE id = X AND user_id = Y pattern
-- Solution: Add composite index to speed up lookups

-- Add index for the common WHERE id = X AND user_id = Y pattern
-- This helps with playback updates and other single-item user queries
CREATE INDEX IF NOT EXISTS idx_content_items_id_user_id ON content_items(id, user_id);
