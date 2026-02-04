-- Migration 013: Add feed_items table for caching RSS feed items
-- This table stores parsed RSS/Atom feed items to avoid fetching from network on every page load
-- Keeps up to 100 most recent items per feed, auto-cleaned on refresh

CREATE TABLE IF NOT EXISTS feed_items (
    id SERIAL PRIMARY KEY,
    feed_id INTEGER NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,

    -- Item metadata
    item_type VARCHAR(50) NOT NULL, -- 'podcast_episode' or 'article'
    title VARCHAR(500) NOT NULL,
    description TEXT, -- Limited to 2000 chars on insert (stores RSS description/summary)

    -- URLs
    url TEXT, -- Article URL (for newsletters/blogs)
    audio_url TEXT, -- Episode audio URL (for podcasts)

    -- Publishing metadata
    published_at TIMESTAMP NOT NULL,
    duration INTEGER, -- Duration in seconds (podcasts only)

    -- Media
    preview_picture TEXT, -- Episode/article thumbnail

    -- Deduplication
    guid VARCHAR(500), -- Unique identifier from RSS feed (for detecting duplicates)

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Prevent duplicate items in the same feed
    UNIQUE(feed_id, guid)
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_feed_items_feed_id ON feed_items(feed_id);
CREATE INDEX IF NOT EXISTS idx_feed_items_published_at ON feed_items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_items_feed_published ON feed_items(feed_id, published_at DESC);

-- Add last_refreshed_at column to podcasts table to track when feed was last updated
ALTER TABLE podcasts ADD COLUMN IF NOT EXISTS last_refreshed_at TIMESTAMP;
