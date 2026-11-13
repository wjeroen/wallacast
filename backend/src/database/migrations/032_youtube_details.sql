-- Migration 032: YouTube's own details for video items.
--
-- view_count     YouTube's view count (videos.list statistics), NULL without a YouTube key.
-- embed_blocked  Why YouTube's embedded player cannot play the video, so it plays only on
--                YouTube: 'not_embeddable' (the owner turned embedding off) or
--                'age_restricted'. NULL when it can play, or when that is not known (no key).
--
-- A video's comment_count_total holds YouTube's total comment count, and its comments the
-- most relevant comment threads (comment_source 'youtube'), see services/youtube.ts.
-- YouTube's rules allow keeping these details for at most 30 days, so the refresh job in
-- services/youtube-refresh.ts reads them again every 7 days (content_fetched_at).
--
-- Safe to re-run on every boot (db.ts re-runs all migration files): plain IF NOT EXISTS.
-- content_items comes from schema.sql, earlier in the same boot.
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS view_count BIGINT;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS embed_blocked TEXT;
