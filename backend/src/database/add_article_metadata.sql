-- Add EA Forum metadata fields to content_items table
DO $$
BEGIN
  -- Add karma field
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='content_items' AND column_name='karma'
  ) THEN
    ALTER TABLE content_items
    ADD COLUMN karma INTEGER;
  END IF;

  -- Add agree_votes field
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='content_items' AND column_name='agree_votes'
  ) THEN
    ALTER TABLE content_items
    ADD COLUMN agree_votes INTEGER;
  END IF;

  -- Add disagree_votes field
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='content_items' AND column_name='disagree_votes'
  ) THEN
    ALTER TABLE content_items
    ADD COLUMN disagree_votes INTEGER;
  END IF;
END $$;
