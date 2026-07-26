-- Whether the item's CURRENT generated audio actually narrates its comments.
-- Set at audio-generation time (exclude-comments flag + narrate settings + comments
-- present). Alignment includes comment elements only when TRUE; NULL (legacy items,
-- generated before this column) falls back to the settings-based heuristic.
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS comments_in_audio BOOLEAN;
