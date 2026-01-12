-- Add column to store audio file binary data in database
-- This allows audio files to persist across container restarts
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS audio_data BYTEA;

-- Add index for efficient queries when audio_data is present
CREATE INDEX IF NOT EXISTS idx_content_items_has_audio ON content_items((audio_data IS NOT NULL));
