-- Add comment_source column to track where comments were extracted from
-- Values: 'ea_forum', 'lesswrong', 'substack', or NULL (no comments)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'content_items' AND column_name = 'comment_source') THEN
    ALTER TABLE content_items ADD COLUMN comment_source TEXT;
  END IF;
END $$;

-- Add comment_count_total to store total comments including replies
-- (jsonb_array_length only counts top-level, this includes nested replies)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'content_items' AND column_name = 'comment_count_total') THEN
    ALTER TABLE content_items ADD COLUMN comment_count_total INTEGER DEFAULT 0;
  END IF;
END $$;
