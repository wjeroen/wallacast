-- Wallacast Database Schema
-- Field names aligned with Wallabag API for future bidirectional sync

-- Podcasts (shows/feeds) - Must be created first as content_items references it
CREATE TABLE IF NOT EXISTS podcasts (
    id SERIAL PRIMARY KEY,
    title VARCHAR(500) NOT NULL,
    author VARCHAR(255),
    description TEXT,
    feed_url TEXT NOT NULL UNIQUE,
    website_url TEXT,
    preview_picture TEXT,  -- Renamed from thumbnail_url (Wallabag compatibility)
    category VARCHAR(100),
    language VARCHAR(10),
    is_subscribed BOOLEAN DEFAULT TRUE,
    last_fetched_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Content types enum (articles, podcasts, PDFs, etc.)
-- Field names aligned with Wallabag API where applicable
CREATE TABLE IF NOT EXISTS content_items (
    id SERIAL PRIMARY KEY,
    type VARCHAR(50) NOT NULL, -- 'article', 'podcast_episode', 'pdf', 'text'
    title VARCHAR(500) NOT NULL,
    url TEXT,
    content TEXT, -- Original content or transcript
    html_content TEXT, -- For articles
    author VARCHAR(255),
    description TEXT,
    preview_picture TEXT,  -- Renamed from thumbnail_url (Wallabag: preview_picture)
    audio_url TEXT, -- For podcasts or generated TTS
    transcript TEXT, -- For podcasts (from Whisper)
    duration INTEGER, -- In seconds
    file_size BIGINT,

    -- Podcast-specific fields
    podcast_id INTEGER REFERENCES podcasts(id) ON DELETE CASCADE,
    episode_number INTEGER,
    published_at TIMESTAMP,

    -- Organization (Wallabag-compatible naming)
    is_starred BOOLEAN DEFAULT FALSE,  -- Renamed from is_favorite (Wallabag: starred)
    is_archived BOOLEAN DEFAULT FALSE,
    tags TEXT,  -- Comma-separated tags (Wallabag style: "article,tech,toread")

    -- Wallabag sync fields
    wallabag_id INTEGER,  -- ID in Wallabag (NULL if not synced)
    wallabag_updated_at TIMESTAMP,  -- Last update time in Wallabag (for conflict resolution)

    -- Playback state (Wallacast-specific, not synced to Wallabag)
    playback_position INTEGER DEFAULT 0, -- In seconds
    playback_speed DECIMAL(3,2) DEFAULT 1.00,
    last_played_at TIMESTAMP,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Queue for playback
CREATE TABLE IF NOT EXISTS queue_items (
    id SERIAL PRIMARY KEY,
    content_item_id INTEGER NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tags for organization
CREATE TABLE IF NOT EXISTS tags (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    color VARCHAR(7), -- Hex color
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Many-to-many relationship for content and tags
CREATE TABLE IF NOT EXISTS content_tags (
    content_item_id INTEGER NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (content_item_id, tag_id)
);

-- Settings (key-value store for user preferences)
CREATE TABLE IF NOT EXISTS settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_content_items_type ON content_items(type);
CREATE INDEX IF NOT EXISTS idx_content_items_created_at ON content_items(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_items_podcast_id ON content_items(podcast_id);
CREATE INDEX IF NOT EXISTS idx_content_items_is_archived ON content_items(is_archived);
CREATE INDEX IF NOT EXISTS idx_content_items_is_starred ON content_items(is_starred);
CREATE INDEX IF NOT EXISTS idx_content_items_wallabag_id ON content_items(wallabag_id);
CREATE INDEX IF NOT EXISTS idx_queue_items_position ON queue_items(position);
