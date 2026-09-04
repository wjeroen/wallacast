-- Migration 027: tags become a real Postgres array (TEXT[]).
--
-- Why: the old `tags` column was a comma-separated TEXT ("article,tech,toread") that only
-- the Wallabag sync ever wrote. Tags are now user-editable and filterable in the app, so
-- they need a real array: `tags @> ARRAY['x']` filtering with a GIN index, `unnest()` for
-- the per-user tag list, and `array_replace()` for future renames. The array holds ONLY
-- the user's own tags, normalized (lowercase, trimmed, no commas), exactly the way
-- Wallabag normalizes labels. The type tags (article / text / podcast) are NOT stored,
-- they are derived from `type` and re-added when pushing to Wallabag.
--
-- Guard: db.ts re-runs every migration on EVERY boot, so the whole conversion lives in a
-- DO block that fires only while the old TEXT column is still there, and the one-time
-- backfill only runs in the branch that creates the array column. A fresh database
-- (schema.sql already declares TEXT[]) skips everything. The old column is kept as
-- `tags_legacy` for one release so the conversion can be double-checked, then dropped.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'content_items' AND column_name = 'tags' AND data_type = 'text'
  ) THEN
    ALTER TABLE content_items RENAME COLUMN tags TO tags_legacy;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'content_items' AND column_name = 'tags'
  ) THEN
    -- A constant default on ADD COLUMN is metadata-only in Postgres 11+, no table rewrite.
    ALTER TABLE content_items ADD COLUMN tags TEXT[] NOT NULL DEFAULT '{}';

    -- One-time backfill from the comma string: split, trim, lowercase, drop empties and the
    -- type tags, dedupe. Only rows that actually had tags are touched. nosync is kept if a
    -- row somehow carries it, since the push code honors it.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'content_items' AND column_name = 'tags_legacy'
    ) THEN
      UPDATE content_items c SET tags = COALESCE((
        SELECT array_agg(t ORDER BY t) FROM (
          SELECT DISTINCT lower(btrim(x)) AS t
          FROM unnest(string_to_array(c.tags_legacy, ',')) AS x
        ) s
        WHERE t <> '' AND t NOT IN ('article', 'text', 'podcast')
      ), '{}')
      WHERE c.tags_legacy IS NOT NULL AND c.tags_legacy <> '';
    END IF;
  END IF;
END $$;

-- The tag set both sides agreed on at the last sync (the base of the three-way merge in
-- wallabag-sync.ts). NULL = unknown, treated as "equal to the local tags" (no local edits).
-- Backfilled ONCE for already-synced rows from the freshly converted array, which is
-- exactly the last pulled/pushed state the legacy string represented.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'content_items' AND column_name = 'wallabag_synced_tags'
  ) THEN
    ALTER TABLE content_items ADD COLUMN wallabag_synced_tags TEXT[] DEFAULT NULL;
    UPDATE content_items SET wallabag_synced_tags = tags WHERE wallabag_id IS NOT NULL;
  END IF;
END $$;

-- Tag containment lookups (`tags @> ARRAY['x']`) and overlap (`tags && ARRAY[...]`).
CREATE INDEX IF NOT EXISTS idx_content_items_tags ON content_items USING GIN (tags);

-- The original schema also created a normalized `tags` (id, name UNIQUE, color) +
-- `content_tags` pair that nothing ever wrote to (and whose UNIQUE name was global, not
-- per user). They are dropped ONLY while empty, so real data can never be lost here. A
-- per-user tag-metadata table (colors, descriptions) can be added later keyed by label.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'content_tags') THEN
    IF (SELECT count(*) FROM content_tags) = 0 THEN
      DROP TABLE content_tags;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tags')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'content_tags') THEN
    IF (SELECT count(*) FROM tags) = 0 THEN
      DROP TABLE tags;
    END IF;
  END IF;
END $$;
