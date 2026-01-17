import { Router } from 'express';
import { query } from '../database/db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// Known setting keys for validation
const VALID_SETTING_KEYS = [
  // AI Provider settings
  'ai_provider',           // 'openai', 'anthropic', 'google', etc.
  'openai_api_key',
  'openai_model',          // 'gpt-4o-mini', 'gpt-4', etc.
  'openai_tts_model',      // 'gpt-4o-mini-tts', 'tts-1', etc.
  'openai_tts_voice',      // 'alloy', 'echo', 'fable', etc.
  'anthropic_api_key',
  'anthropic_model',
  'google_api_key',
  'google_model',
  // Wallabag settings
  'wallabag_url',
  'wallabag_client_id',
  'wallabag_client_secret',
  'wallabag_username',
  'wallabag_password',     // encrypted
  'wallabag_access_token', // encrypted
  'wallabag_refresh_token',// encrypted
  'wallabag_token_expires_at', // ISO timestamp when access token expires
  'wallabag_last_sync',     // ISO timestamp of last successful sync
  'wallabag_sync_enabled',
  // App preferences
  'theme',
  'playback_speed',
  'auto_archive_after_listen',
];

// Secret keys that should be masked in responses
const SECRET_KEYS = [
  'openai_api_key',
  'anthropic_api_key',
  'google_api_key',
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

    await query(
      `INSERT INTO user_settings (user_id, setting_key, setting_value, is_secret)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, setting_key) DO UPDATE SET
         setting_value = EXCLUDED.setting_value,
         updated_at = NOW()`,
      [req.user!.userId, key, value, isSecret]
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

    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'Settings object required' });
    }

    for (const [key, value] of Object.entries(settings)) {
      if (!VALID_SETTING_KEYS.includes(key)) {
        continue; // Skip unknown keys
      }

      const isSecret = SECRET_KEYS.includes(key);

      await query(
        `INSERT INTO user_settings (user_id, setting_key, setting_value, is_secret)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, setting_key) DO UPDATE SET
           setting_value = EXCLUDED.setting_value,
           updated_at = NOW()`,
        [req.user!.userId, key, value as string, isSecret]
      );
    }

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
  // Return available providers and their configuration options
  // This makes it easy to add new providers later
  const providers = {
    openai: {
      name: 'OpenAI',
      models: {
        chat: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'],
        tts: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
      },
      voices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'coral'],
      requiredSettings: ['openai_api_key'],
      description: 'OpenAI GPT models for text processing and TTS',
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
