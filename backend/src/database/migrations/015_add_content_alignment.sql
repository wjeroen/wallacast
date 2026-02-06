-- Migration: Add content_alignment column for storing text-to-transcript alignment mappings
-- This enables synchronized highlighting in the read-along tab by mapping original content
-- words to Whisper transcript timestamps

DO $$
BEGIN
  -- Add content_alignment column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'content'
    AND column_name = 'content_alignment'
  ) THEN
    ALTER TABLE content
    ADD COLUMN content_alignment JSONB DEFAULT NULL;

    COMMENT ON COLUMN content.content_alignment IS
      'Stores mapping between original content words and transcript timestamps. ' ||
      'Format: { "words": [...], "sections": [...], "comments_start_time": number }';
  END IF;
END $$;
