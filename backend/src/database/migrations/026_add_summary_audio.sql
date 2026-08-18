-- Migration: Add summary-audio columns to content_items
-- A second, independent TTS audio per item, generated from the stored summary text
-- (no whisper transcription, no read-along alignment). The file lives on the volume
-- as `<id>-summary.mp3` and is served via GET /api/content/:id/audio?variant=summary.

DO $$
BEGIN
  -- Token-less URL to our own audio endpoint with ?variant=summary (the HMAC token
  -- is appended at serialization time, same as audio_url).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'content_items' AND column_name = 'summary_audio_url'
  ) THEN
    ALTER TABLE content_items ADD COLUMN summary_audio_url TEXT DEFAULT NULL;
  END IF;

  -- Duration in seconds (summary audio is short, typically 1-3 minutes)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'content_items' AND column_name = 'summary_audio_duration'
  ) THEN
    ALTER TABLE content_items ADD COLUMN summary_audio_duration INTEGER DEFAULT NULL;
  END IF;

  -- Independent of generation_status AND summary_status so all three can run at once.
  -- Values: 'idle' | 'generating' | 'completed' | 'failed'
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'content_items' AND column_name = 'summary_audio_status'
  ) THEN
    ALTER TABLE content_items ADD COLUMN summary_audio_status VARCHAR(50) DEFAULT 'idle';
  END IF;

  -- Error message stored when summary_audio_status = 'failed' (surfaced in the UI)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'content_items' AND column_name = 'summary_audio_error'
  ) THEN
    ALTER TABLE content_items ADD COLUMN summary_audio_error TEXT DEFAULT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'content_items' AND column_name = 'summary_audio_generated_at'
  ) THEN
    ALTER TABLE content_items ADD COLUMN summary_audio_generated_at TIMESTAMPTZ DEFAULT NULL;
  END IF;

  -- Separate saved position: listening to the summary must never corrupt the
  -- original audio's playback_position (card progress stays original-only).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'content_items' AND column_name = 'summary_playback_position'
  ) THEN
    ALTER TABLE content_items ADD COLUMN summary_playback_position INTEGER DEFAULT 0;
  END IF;
END $$;
