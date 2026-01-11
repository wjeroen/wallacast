-- Add generation status tracking fields to content_items table
DO $$
BEGIN
  -- Add generation_status column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='content_items' AND column_name='generation_status'
  ) THEN
    ALTER TABLE content_items
    ADD COLUMN generation_status VARCHAR(50) DEFAULT 'idle';
  END IF;

  -- Add generation_progress column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='content_items' AND column_name='generation_progress'
  ) THEN
    ALTER TABLE content_items
    ADD COLUMN generation_progress INTEGER DEFAULT 0;
  END IF;

  -- Add generation_error column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='content_items' AND column_name='generation_error'
  ) THEN
    ALTER TABLE content_items
    ADD COLUMN generation_error TEXT;
  END IF;

  -- Add current_operation column to track what's being generated (audio/transcript)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='content_items' AND column_name='current_operation'
  ) THEN
    ALTER TABLE content_items
    ADD COLUMN current_operation VARCHAR(50);
  END IF;
END $$;

-- Create an index on generation_status for efficient querying
CREATE INDEX IF NOT EXISTS idx_content_items_generation_status ON content_items(generation_status);

-- Set existing items that have audio as completed
UPDATE content_items
SET generation_status = 'completed', generation_progress = 100
WHERE audio_url IS NOT NULL AND generation_status = 'idle';

-- Set podcast episodes with transcripts as completed
UPDATE content_items
SET generation_status = 'completed', generation_progress = 100
WHERE transcript IS NOT NULL AND generation_status = 'idle';
