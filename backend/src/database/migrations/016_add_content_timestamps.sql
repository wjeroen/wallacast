-- 016: Add content_fetched_at and audio_generated_at timestamps
-- content_fetched_at: when the article was last fetched/refetched from the web
-- audio_generated_at: when TTS narration was last generated for the item
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS content_fetched_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS audio_generated_at TIMESTAMP WITH TIME ZONE;
