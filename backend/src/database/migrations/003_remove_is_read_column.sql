-- Remove unused is_read column
-- This column only made cards slightly transparent but had no real functionality

ALTER TABLE content_items DROP COLUMN IF EXISTS is_read;
