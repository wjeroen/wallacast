-- Migration 024: Version snapshots also keep author + published_at.
--
-- Title has been part of every snapshot since migration 020. Now that title,
-- author, and date are editable in the player's Markdown editor, restoring a
-- version should be able to roll those back too. Snapshots taken before this
-- migration have NULL in the new columns; the restore route uses COALESCE so
-- such snapshots keep the item's current value instead of wiping it.

ALTER TABLE content_versions ADD COLUMN IF NOT EXISTS author TEXT;
ALTER TABLE content_versions ADD COLUMN IF NOT EXISTS published_at TIMESTAMP;
