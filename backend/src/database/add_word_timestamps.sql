-- Add column for word-level timestamps from Whisper
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS transcript_words JSONB;

-- Add index for faster querying
CREATE INDEX IF NOT EXISTS idx_content_items_transcript_words ON content_items USING GIN (transcript_words);

-- Add column for TTS chunk metadata
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS tts_chunks JSONB;
