-- Migration 018: Add author column to feed_items table
-- RSS feeds include per-item author info (dc:creator, author, itunes:author)
-- that should be displayed in the Feed tab alongside the feed name

ALTER TABLE feed_items ADD COLUMN IF NOT EXISTS author VARCHAR(255);
