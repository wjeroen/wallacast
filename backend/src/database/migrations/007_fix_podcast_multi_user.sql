-- Migration: Fix podcast subscriptions for multi-user support
-- Problem: UNIQUE constraint on feed_url prevents multiple users from subscribing to same podcast
-- Solution: Change to composite UNIQUE constraint on (feed_url, user_id)

-- Idempotent migration: Only add constraint if it doesn't exist
DO $$ BEGIN
    -- Drop the old UNIQUE constraint on feed_url if it exists
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'podcasts_feed_url_key'
    ) THEN
        ALTER TABLE podcasts DROP CONSTRAINT podcasts_feed_url_key;
    END IF;

    -- Add new composite UNIQUE constraint only if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'podcasts_feed_url_user_id_key'
    ) THEN
        ALTER TABLE podcasts ADD CONSTRAINT podcasts_feed_url_user_id_key UNIQUE (feed_url, user_id);
    END IF;
END $$;
