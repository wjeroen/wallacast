-- Migration: Fix podcast subscriptions for multi-user support
-- Problem: UNIQUE constraint on feed_url prevents multiple users from subscribing to same podcast
-- Solution: Change to composite UNIQUE constraint on (feed_url, user_id)

-- Drop the old UNIQUE constraint on feed_url
ALTER TABLE podcasts DROP CONSTRAINT IF EXISTS podcasts_feed_url_key;

-- Add new composite UNIQUE constraint
ALTER TABLE podcasts ADD CONSTRAINT podcasts_feed_url_user_id_key UNIQUE (feed_url, user_id);
