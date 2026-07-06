-- Migration 022: explicit dirty flag for the Wallacast -> Wallabag push.
--
-- Why: the push used to decide "this item changed locally, send it" by comparing
-- updated_at > wallabag_updated_at. That comparison is broken because wallabag_updated_at
-- stores a foreign wall-clock timestamp (the timezone offset is stripped when Wallabag's
-- value is parsed into a plain TIMESTAMP), so the two columns are not on the same clock.
-- A boolean "needs push" flag is unambiguous: set it TRUE on any local change that should
-- sync, set it FALSE right after a successful push.
ALTER TABLE content_items
  ADD COLUMN IF NOT EXISTS wallabag_needs_push BOOLEAN NOT NULL DEFAULT FALSE;

-- One-time backfill: anything that looks dirty under the OLD heuristic is marked dirty now,
-- so items edited before this migration are not silently dropped from the next push.
UPDATE content_items
  SET wallabag_needs_push = TRUE
  WHERE wallabag_id IS NOT NULL
    AND updated_at > COALESCE(wallabag_updated_at, '1970-01-01'::timestamp);
