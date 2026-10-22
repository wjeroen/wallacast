-- Migration 031: permissions, limits and an event log for API tokens.
--
-- Migration 029 made tokens read-only. A token now carries its own permissions (what it may
-- call, see TOKEN_ROUTES in services/api-tokens.ts), its own limits (how much it may add and
-- generate per hour and per 2 days, see services/token-limits.ts) and its own generation
-- choice for the items it adds (follow the app's auto-generation settings, or its own).
-- Existing tokens keep exactly what they could do before: the permissions default is the
-- read-only set, so no backfill is needed.
--
-- api_token_events is the usage log and the change log in one table:
--   kind 'add' / 'read'      one item added, or one page read without saving (item limits)
--   kind 'generation'        `minutes` of AI generation started for an item (minute limits)
--   kind 'refresh'           a feed refresh started through the token
--   kind 'tag_add' / 'star' / 'unstar'   one change to one item, undoable from Settings
-- Counting from the database keeps the limits across deploys. content_item_id is SET NULL
-- when an item is deleted, so deleting junk never frees the budget it used.
--
-- `scope` (029) stays, always 'read', and nothing reads it any more.
--
-- Safe to re-run on every boot (db.ts re-runs all migration files): plain IF NOT EXISTS.
-- api_tokens comes from 029 and content_items from schema.sql, both earlier in the same boot.
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS permissions TEXT[] NOT NULL DEFAULT ARRAY['read_library']::TEXT[];
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS limits JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS generation JSONB NOT NULL DEFAULT '{"follow": true}'::JSONB;
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS usage_reset_at TIMESTAMP;
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS limit_hit TEXT;
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS limit_hit_at TIMESTAMP;
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS limit_notice_seen_at TIMESTAMP;

CREATE TABLE IF NOT EXISTS api_token_events (
  id SERIAL PRIMARY KEY,
  token_id INTEGER NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind VARCHAR(20) NOT NULL,
  content_item_id INTEGER REFERENCES content_items(id) ON DELETE SET NULL,
  tag TEXT,
  minutes REAL NOT NULL DEFAULT 0,
  detail VARCHAR(40),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  undone_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_api_token_events_token ON api_token_events(token_id, created_at);
