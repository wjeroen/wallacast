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

-- Backfill comment_source for existing articles based on URL
UPDATE content_items SET comment_source = 'lesswrong'
WHERE comment_source IS NULL AND comments IS NOT NULL AND url LIKE '%lesswrong.com%';

UPDATE content_items SET comment_source = 'ea_forum'
WHERE comment_source IS NULL AND comments IS NOT NULL AND url LIKE '%forum.effectivealtruism.org%';

-- For Substack on custom domains, check html_content for substackcdn.com
UPDATE content_items SET comment_source = 'substack'
WHERE comment_source IS NULL AND comments IS NOT NULL
  AND (url LIKE '%substack.com%' OR html_content LIKE '%substackcdn.com%');
