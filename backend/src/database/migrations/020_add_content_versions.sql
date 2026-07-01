-- Migration 020: Version history for article/text content.
--
-- Keeps a snapshot of the body (html_content + content + comments) BEFORE every overwrite
-- (edit, refetch, restore) so a bad edit or a poor refetch can be rolled back. Audio is
-- deliberately NOT versioned (too large, see TODO.md).
--
-- Snapshots are tiny (HTML is ~50-100KB), so this is cheap. The app keeps the most recent
-- N per item (pruned in application code on insert).

CREATE TABLE IF NOT EXISTS content_versions (
  id SERIAL PRIMARY KEY,
  content_item_id INTEGER NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- What produced THIS snapshot's overwrite: 'fetch' | 'refetch' | 'edit' | 'restore'
  source VARCHAR(20) NOT NULL DEFAULT 'edit',
  title TEXT,
  html_content TEXT,
  content TEXT,
  comments JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Fast lookup of an item's versions, newest first.
CREATE INDEX IF NOT EXISTS idx_content_versions_item
  ON content_versions (content_item_id, created_at DESC);
