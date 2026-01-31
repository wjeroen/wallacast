-- Add type field to podcasts table to support different RSS feed types
-- 'podcast': Audio podcast feed (default)
-- 'newsletter': Text-based newsletter (Substack, etc)
-- 'blog': Blog RSS feed

ALTER TABLE podcasts
ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'podcast';

-- Mark all existing feeds as podcasts
UPDATE podcasts
SET type = 'podcast'
WHERE type IS NULL;
