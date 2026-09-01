-- Migration 028: remember the star and archive values both sides agreed on at the last sync.
--
-- Tags already merge three-way against `wallabag_synced_tags`. The star and archive flags did
-- not. When a pull decided both sides had changed, it copied Wallabag's flags over the local
-- ones, so a star set in Wallacast was silently undone by Wallabag even though the documented
-- rule is that Wallacast wins. Storing the last agreed value lets the sync tell WHICH side
-- moved a flag and keep that side's value, exactly like the tag merge.
--
-- Backfill: for items already linked to Wallabag, the base is set to the current LOCAL value.
-- That choice makes the first sync after this migration behave exactly like the old code. An
-- item whose flag already differs between the two sides reads as "Wallacast never moved it,
-- so Wallabag must have", and Wallabag's value wins, which is what happened before. From the
-- second sync onward every change carries a real base, so the side that actually moved wins.
-- Nothing can be lost either way: these are two reversible one-bit flags, not content.
--
-- Idempotent: the columns are added only if missing, and the backfill only touches rows that
-- have no base yet, so re-running this on every boot is a no-op.

ALTER TABLE content_items ADD COLUMN IF NOT EXISTS wallabag_synced_starred BOOLEAN;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS wallabag_synced_archived BOOLEAN;

UPDATE content_items
   SET wallabag_synced_starred = is_starred,
       wallabag_synced_archived = is_archived
 WHERE wallabag_id IS NOT NULL
   AND (wallabag_synced_starred IS NULL OR wallabag_synced_archived IS NULL);
