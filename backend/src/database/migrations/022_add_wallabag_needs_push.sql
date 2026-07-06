-- Migration 022: explicit dirty flag for the Wallacast -> Wallabag push.
--
-- Why: the push used to decide "this item changed locally, send it" by comparing
-- updated_at > wallabag_updated_at. That comparison is broken because wallabag_updated_at
-- stores a foreign wall-clock timestamp (the timezone offset is stripped when Wallabag's
-- value is parsed into a plain TIMESTAMP), so the two columns are not on the same clock.
-- A boolean "needs push" flag is unambiguous: set it TRUE on any local change that should
-- sync, set it FALSE right after a successful push.
--
-- Guard: db.ts re-runs every migration file on EVERY server boot (there is no version
-- tracking), so both the column creation AND the one-time backfill live inside a single
-- DO block that fires ONLY when the column does not yet exist. The backfill uses the OLD
-- broken timestamp heuristic, which is true for most already-synced items, so running it
-- on every boot would re-mark the whole library dirty and re-push everything each restart.
-- Gating on information_schema.columns makes the backfill fire exactly once, the first time
-- the column is created. When the column already exists the block does nothing.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'content_items' AND column_name = 'wallabag_needs_push'
  ) THEN
    ALTER TABLE content_items
      ADD COLUMN wallabag_needs_push BOOLEAN NOT NULL DEFAULT FALSE;

    -- One-time backfill: anything that looks dirty under the OLD heuristic is marked dirty now,
    -- so items edited before this migration are not silently dropped from the next push. This
    -- runs only here, inside the "column did not exist" branch, so it happens exactly once.
    UPDATE content_items
      SET wallabag_needs_push = TRUE
      WHERE wallabag_id IS NOT NULL
        AND updated_at > COALESCE(wallabag_updated_at, '1970-01-01'::timestamp);
  END IF;
END $$;
