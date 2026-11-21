-- The loudness of a podcast episode's own file, measured over the whole file once
-- (services/loudness.ts): integrated LUFS in stereo terms (a mono file's measurement + 3, so
-- it compares with our TTS at -16). The player turns an episode louder than -14 down to -16,
-- and the server keeps a raised copy of one quieter than -18 (services/podcast-cache.ts).
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS loudness_lufs REAL;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS loudness_measured_at TIMESTAMPTZ;
