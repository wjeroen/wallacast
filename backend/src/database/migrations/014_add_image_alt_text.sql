-- Migration: Add image alt-text columns to content_items and user_settings
-- This enables Gemini-powered image description generation for TTS audio

-- Add columns to content_items table for tracking image processing
DO $$
BEGIN
  -- Track if images have been processed
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'content_items' AND column_name = 'images_processed'
  ) THEN
    ALTER TABLE content_items ADD COLUMN images_processed BOOLEAN DEFAULT FALSE;
  END IF;

  -- Store image descriptions and metadata as JSONB
  -- Structure: {
  --   "descriptions": { "https://example.com/img.jpg": "A bar chart showing..." },
  --   "total_images": 5,
  --   "decorative_images": 2,
  --   "cost_usd": 0.0023,
  --   "model": "gemini-3-flash-preview",
  --   "processed_at": "2026-02-04T10:30:00Z"
  -- }
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'content_items' AND column_name = 'image_alt_text_data'
  ) THEN
    ALTER TABLE content_items ADD COLUMN image_alt_text_data JSONB DEFAULT NULL;
  END IF;
END $$;

-- Add user setting for image alt-text generation toggle
-- (User settings are stored in user_settings table with key-value pairs)
-- Default is TRUE (enabled) - users can opt out in Settings UI
INSERT INTO user_settings (user_id, setting_key, setting_value)
SELECT id, 'image_alt_text_enabled', 'true'
FROM users
WHERE NOT EXISTS (
  SELECT 1 FROM user_settings
  WHERE user_settings.user_id = users.id
  AND setting_key = 'image_alt_text_enabled'
);
