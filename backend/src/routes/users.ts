import { Router } from 'express';
import { query } from '../database/db.js';
import { requireAuth } from '../middleware/auth.js';
import { encrypt } from '../services/encryption.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// Known setting keys for validation
const VALID_SETTING_KEYS = [
  // AI Provider settings
  'ai_provider',           // 'openai' (now acts as hybrid provider)
  'openai_api_key',
  'deepinfra_api_key',     // NEW: DeepInfra key for cheaper audio
  'openai_model',          // 'gpt-4o-mini', 'gpt-4', etc.
  'openai_tts_model',      // 'gpt-4o-mini-tts', 'hexgrad/Kokoro-82M'
  'openai_tts_voice',      // 'alloy', 'af_heart', etc.
  'anthropic_api_key',
  'anthropic_model',
  'google_api_key',
  'google_model',
  'gemini_api_key',        // NEW: For image alt-text generation
  // Wallabag settings
  'wallabag_url',
  'wallabag_client_id',
  'wallabag_client_secret',
  'wallabag_username',
  'wallabag_password',
  'wallabag_access_token',
  'wallabag_refresh_token',
  'wallabag_token_expires_at',
  'wallabag_last_sync',
  'wallabag_sync_enabled',
  // App preferences
  'theme',
  'playback_speed',
  'narration_llm',           // 'auto', 'deepseek', 'openai', 'openai-mini' - which LLM prepares text for TTS
  'auto_archive_after_listen',
  'auto_transcribe_podcasts',
  'auto_generate_audio_for_articles',
  'image_alt_text_enabled', // NEW: Toggle for image descriptions in audio
  'narrate_ea_forum_comments',  // Include EA Forum/LessWrong comments in TTS audio (default: true)
  'narrate_substack_comments',  // Include Substack comments in TTS audio (default: true)
  'max_narrated_comments',      // Max total comments (incl. replies) to narrate (default: 50)
  'reader_font_scale',          // Font scale for read-along/description/transcript content (default: 1)
];

// Secret keys that should be masked in responses
const SECRET_KEYS = [
  'openai_api_key',
  'deepinfra_api_key',     // NEW: Mask this key
  'anthropic_api_key',
  'google_api_key',
  'gemini_api_key',        // NEW: Mask Gemini key
  'wallabag_client_secret',
  'wallabag_password',
  'wallabag_access_token',
  'wallabag_refresh_token',
];

// GET /api/users/settings - Get all settings for current user
router.get('/settings', async (req, res) => {
  try {
    const result = await query(
      'SELECT setting_key, setting_value, is_secret FROM user_settings WHERE user_id = $1',
      [req.user!.userId]
    );

    // Build settings object, masking secrets
    const settings: Record<string, string | null> = {};
    for (const row of result.rows) {
      if (row.is_secret && row.setting_value) {
        // Show that a value is set, but mask it
        settings[row.setting_key] = '••••••••';
      } else {
        settings[row.setting_key] = row.setting_value;
      }
    }

    res.json({ settings });
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// GET /api/users/settings/:key - Get a specific setting
router.get('/settings/:key', async (req, res) => {
  try {
    const { key } = req.params;

    const result = await query(
      'SELECT setting_value, is_secret FROM user_settings WHERE user_id = $1 AND setting_key = $2',
      [req.user!.userId, key]
    );

    if (result.rows.length === 0) {
      return res.json({ value: null });
    }

    const row = result.rows[0];
    if (row.is_secret && row.setting_value) {
      return res.json({ value: '••••••••', isSet: true });
    }

    res.json({ value: row.setting_value });
  } catch (error) {
    console.error('Error fetching setting:', error);
    res.status(500).json({ error: 'Failed to fetch setting' });
  }
});

// PUT /api/users/settings/:key - Set a specific setting
router.put('/settings/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    if (!VALID_SETTING_KEYS.includes(key)) {
      return res.status(400).json({ error: `Unknown setting key: ${key}` });
    }

    const isSecret = SECRET_KEYS.includes(key);
    const storedValue = isSecret && value ? encrypt(value) : value;

    await query(
      `INSERT INTO user_settings (user_id, setting_key, setting_value, is_secret)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, setting_key) DO UPDATE SET
         setting_value = EXCLUDED.setting_value,
         updated_at = NOW()`,
      [req.user!.userId, key, storedValue, isSecret]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error saving setting:', error);
    res.status(500).json({ error: 'Failed to save setting' });
  }
});

// PUT /api/users/settings - Bulk update settings
router.put('/settings', async (req, res) => {
  try {
    const { settings } = req.body;

    console.log(`[SETTINGS] User ${req.user!.userId} attempting to save settings:`, Object.keys(settings));

    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'Settings object required' });
    }

    const savedKeys: string[] = [];
    const skippedKeys: string[] = [];

    for (const [key, value] of Object.entries(settings)) {
      if (!VALID_SETTING_KEYS.includes(key)) {
        skippedKeys.push(key);
        // console.log(`[SETTINGS] ⚠️  Skipping unknown key: ${key}`);
        continue; // Skip unknown keys
      }

      savedKeys.push(key);
      // console.log(`[SETTINGS] ✓ Saving ${key} = ${typeof value === 'string' && value.length > 50 ? '[REDACTED]' : value}`);

      const isSecret = SECRET_KEYS.includes(key);
      const storedValue = isSecret && value ? encrypt(value as string) : value as string;

      await query(
        `INSERT INTO user_settings (user_id, setting_key, setting_value, is_secret)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, setting_key) DO UPDATE SET
         setting_value = EXCLUDED.setting_value,
         updated_at = NOW()`,
        [req.user!.userId, key, storedValue, isSecret]
      );
    }

    console.log(`[SETTINGS] ✅ Saved ${savedKeys.length} settings`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving settings:', error);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// DELETE /api/users/settings/:key - Delete a setting
router.delete('/settings/:key', async (req, res) => {
  try {
    const { key } = req.params;

    await query(
      'DELETE FROM user_settings WHERE user_id = $1 AND setting_key = $2',
      [req.user!.userId, key]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting setting:', error);
    res.status(500).json({ error: 'Failed to delete setting' });
  }
});

// GET /api/users/ai-providers - Get available AI providers and their config
router.get('/ai-providers', async (_req, res) => {
  const providers = {
    openai: {
      name: 'OpenAI (Hybrid)',
      models: {
        chat: ['gpt-5-nano', 'gpt-5-mini', 'gpt-4o-mini', 'gpt-4o'],
        // Added Kokoro to the list so it appears in dropdowns if the frontend uses this
        tts: ['gpt-4o-mini-tts', 'tts-1', 'hexgrad/Kokoro-82M'],
      },
      voices: [
        // OpenAI Voices
        'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'coral',
        // Kokoro Voices (DeepInfra)
        'af_heart', 'af_bella', 'af_nicole', 'am_adam', 'am_michael', 'am_puck'
      ],
      requiredSettings: ['openai_api_key'], // DeepInfra is optional but recommended
      description: 'OpenAI for Chat. DeepInfra supported for cheaper Audio/TTS.',
    },
    anthropic: {
      name: 'Anthropic',
      models: {
        chat: ['claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku'],
      },
      requiredSettings: ['anthropic_api_key'],
      description: 'Claude models for text processing (no TTS)',
      comingSoon: true,
    },
    google: {
      name: 'Google AI',
      models: {
        chat: ['gemini-pro', 'gemini-pro-vision'],
      },
      requiredSettings: ['google_api_key'],
      description: 'Google Gemini models (no TTS)',
      comingSoon: true,
    },
  };

  res.json({ providers });
});

export default router;
