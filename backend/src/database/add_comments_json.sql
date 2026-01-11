-- Add comments field to content_items table for storing structured comment data
DO $$
BEGIN
  -- Add comments field (JSON array)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='content_items' AND column_name='comments'
  ) THEN
    ALTER TABLE content_items
    ADD COLUMN comments JSONB;
  END IF;
END $$;
