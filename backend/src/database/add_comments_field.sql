-- Add comments JSON field to content_items table
DO $$
BEGIN
  -- Add comments field for structured comment data
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='content_items' AND column_name='comments'
  ) THEN
    ALTER TABLE content_items
    ADD COLUMN comments JSONB;
  END IF;
END $$;
