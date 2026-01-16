-- Migration: Wallabag compatibility renames and new fields
-- Renames: is_favorite -> is_starred, thumbnail_url -> preview_picture
-- New fields: wallabag_id, wallabag_updated_at, tags
-- Safe for both fresh databases (with new schema) and existing databases (with old column names)

-- Rename is_favorite to is_starred (matches Wallabag API) - only if old column exists
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'content_items' AND column_name = 'is_favorite') THEN
        ALTER TABLE content_items RENAME COLUMN is_favorite TO is_starred;
    END IF;
END $$;

-- Rename thumbnail_url to preview_picture (matches Wallabag API) - only if old column exists
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'content_items' AND column_name = 'thumbnail_url') THEN
        ALTER TABLE content_items RENAME COLUMN thumbnail_url TO preview_picture;
    END IF;
END $$;

-- Also rename in podcasts table for consistency - only if old column exists
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'podcasts' AND column_name = 'thumbnail_url') THEN
        ALTER TABLE podcasts RENAME COLUMN thumbnail_url TO preview_picture;
    END IF;
END $$;

-- Add Wallabag sync fields
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS wallabag_id INTEGER;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS wallabag_updated_at TIMESTAMP;

-- Add tags field (comma-separated string, Wallabag style)
-- This stores tags like "article,tech,toread"
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS tags TEXT;

-- Create index for Wallabag sync lookups
CREATE INDEX IF NOT EXISTS idx_content_items_wallabag_id ON content_items(wallabag_id);

-- Drop old index name if it exists (from old is_favorite column)
DROP INDEX IF EXISTS idx_content_items_is_favorite;

-- Create index with new name (idempotent)
CREATE INDEX IF NOT EXISTS idx_content_items_is_starred ON content_items(is_starred);
