-- Migration 033: archived audio is deleted 7 days after archiving, and API tokens can follow feeds.
--
-- content_items.archived_at  When the item was last archived, NULL while it is not archived.
--   The trigger below sets it whenever is_archived changes, from any code path (the app, an
--   API token, the Wallabag sync), so no route has to remember it. The hourly job in
--   services/archive-cleanup.ts deletes the generated audio of articles and texts archived
--   more than 7 days ago, so unarchiving within those 7 days keeps the audio. Items archived
--   before this migration keep archived_at NULL and are never touched by the job (their audio
--   was already removed at archive time, or they were starred).
--
-- api_token_events.podcast_id  The feed a token subscribed to or unsubscribed from (kinds
--   'subscribe' and 'unsubscribe'), for the change log and its Undo. SET NULL when the feed
--   row is deleted.
--
-- Safe to re-run on every boot (db.ts re-runs all migration files): IF NOT EXISTS, CREATE OR
-- REPLACE, and DROP TRIGGER IF EXISTS before CREATE TRIGGER.
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_content_items_archived_at ON content_items(archived_at) WHERE archived_at IS NOT NULL;

CREATE OR REPLACE FUNCTION content_items_set_archived_at() RETURNS trigger AS $$
BEGIN
  IF NEW.is_archived THEN
    NEW.archived_at := NOW();
  ELSE
    NEW.archived_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_items_archived_at ON content_items;
CREATE TRIGGER content_items_archived_at
  BEFORE UPDATE OF is_archived ON content_items
  FOR EACH ROW
  WHEN (NEW.is_archived IS DISTINCT FROM OLD.is_archived)
  EXECUTE FUNCTION content_items_set_archived_at();

ALTER TABLE api_token_events ADD COLUMN IF NOT EXISTS podcast_id INTEGER REFERENCES podcasts(id) ON DELETE SET NULL;
