-- The heard check (POST /api/content/:id/listened): how many seconds of each part the user
-- really listened to (normal playback only, a jump never counts), and when each part last
-- counted as heard. Heard: the part played to its end and the listening reached its share of
-- the length (audio: half up to 10 minutes, a quarter above. Summary audio: three quarters).
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS listened_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS summary_listened_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS heard_at TIMESTAMPTZ;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS summary_heard_at TIMESTAMPTZ;
