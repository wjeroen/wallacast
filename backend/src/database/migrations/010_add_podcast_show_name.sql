-- Add podcast_show_name column to content_items
-- Stores the podcast title so episodes don't require the podcasts table to be queried
ALTER TABLE content_items
ADD COLUMN IF NOT EXISTS podcast_show_name VARCHAR(500);

-- Create index for podcast episodes (type + user_id + podcast_show_name for filtering)
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_show_name
ON content_items(user_id, type, podcast_show_name)
WHERE type = 'podcast_episode';
