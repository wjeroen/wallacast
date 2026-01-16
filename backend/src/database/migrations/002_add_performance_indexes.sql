-- Add indexes for query performance
-- These indexes significantly speed up filtering and sorting operations

-- Index on created_at for ORDER BY created_at DESC (most common query)
CREATE INDEX IF NOT EXISTS idx_content_items_created_at ON content_items(created_at DESC);

-- Index on type for filtering by content type
CREATE INDEX IF NOT EXISTS idx_content_items_type ON content_items(type);

-- Index on is_archived for filtering archived vs active items
CREATE INDEX IF NOT EXISTS idx_content_items_is_archived ON content_items(is_archived);

-- Index on is_starred for filtering starred items (renamed from is_favorite for Wallabag compatibility)
CREATE INDEX IF NOT EXISTS idx_content_items_is_starred ON content_items(is_starred);

-- Composite index for common filter combinations
CREATE INDEX IF NOT EXISTS idx_content_items_type_archived ON content_items(type, is_archived);
