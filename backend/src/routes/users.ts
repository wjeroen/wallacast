import { Router } from 'express';
import { query } from '../database/db.js';
import { requireAuth } from '../middleware/auth.js';
import { encrypt } from '../services/encryption.js';
import { PROMPT_REGISTRY, PROMPT_SETTING_KEYS } from '../services/prompt-registry.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// Known setting keys for validation
const VALID_SETTING_KEYS = [
  // AI Provider settings
  'openai_api_key',
  'deepinfra_api_key',     // NEW: DeepInfra key for cheaper audio
  'openrouter_api_key',    // NEW: OpenRouter key (one key → Claude, Gemini, Llama, ...)
  'openai_tts_model',      // 'gpt-4o-mini-tts', 'hexgrad/Kokoro-82M'
  'openai_tts_voice',      // 'alloy', 'af_heart', etc. (single fallback voice)
  'tts_voices',            // JSON array of { model, voice }, rotate randomly between these
  'anthropic_api_key',
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
  'playback_speed',
  'narration_llm',           // LEGACY routing ('auto'|'deepseek'|'openai'|'openai-mini'); read-time fallback only
  // Per-job model config (provider + free-text model + optional reasoning effort).
  // Provider ids: 'openai' | 'deepinfra' | 'openrouter' | 'anthropic' | 'gemini'.
  // Empty reasoning_effort = provider default (no param sent, preserves current behavior).
  'narration_provider', 'narration_model', 'narration_reasoning_effort',
  'alignment_same_as_narration', 'alignment_provider', 'alignment_model', 'alignment_reasoning_effort',
  'summary_same_as_narration', 'summary_provider', 'summary_model', 'summary_reasoning_effort',
  // Transcription (Whisper): provider 'deepinfra' | 'openai'. OpenRouter was removed: its
  // endpoint returns no word timestamps, which read-along requires (verified 2026-07-02).
  'transcription_provider', 'transcription_model',
  'kokoro_tts_provider',     // route Kokoro TTS voices via 'deepinfra' (default) or 'openrouter'
  'image_alt_text_provider', // image descriptions via 'gemini' (default), 'deepinfra', 'openai', or 'openrouter'
  'image_alt_text_model',    // model for image descriptions (free-text; default gemini-3-flash-preview)
  'auto_transcribe_podcasts',
  'auto_generate_audio_for_articles',
  'auto_generate_summary',      // Auto-generate a summary when an article/text is added
  'summarize_comments',         // Also generate a summary of the comment discussion (default: true)
  'summary_tiers',              // JSON: sorted list of { maxChars, maxTweets } tiers (Infinity stored as null)
  'summary_max_words',          // Max words per summary paragraph ("tweet"); default 40
  // Custom prompt overrides (prompt_<id>) for every editable prompt, see services/prompt-registry.ts.
  // Blank/whitespace = use the built-in default. Spread so the list stays in sync with the registry.
  ...PROMPT_SETTING_KEYS,
  'library_show_summary',       // Show the article summary (not the description) on library cards
  'image_alt_text_enabled', // NEW: Toggle for image descriptions in audio
  'narrate_ea_forum_comments',  // Include EA Forum/LessWrong comments in TTS audio (default: true)
  'narrate_substack_comments',  // Include Substack comments in TTS audio (default: true)
  'max_narrated_comments',      // Max total comments (incl. replies) to narrate (default: 50)
  'reader_font_scale',          // Font scale for read-along/description/transcript content (default: 1)
  'queue_autoplay',             // Auto-continue into non-manual (library) items when queue empties (default: false)
  'manual_queue_always_autoplay', // When 'false', manual queue items only auto-advance if queue_autoplay is on. Default: 'true' (manual items always autoplay).
  'queue_shuffle',              // Persisted shuffle preference for the queue (frontend queueStore)
  'autoplay_on_open',           // Start playing when a library item is opened (default: false)
  'playback_speed_options',     // JSON array of speeds the player's speed button cycles through (blank = default set)
  'show_continue_listening',    // Show the continue-listening row in the library (default: true)
  'warn_archive_removes_audio', // Confirm before archiving a non-starred article/text with generated audio (default: true)
];

// Secret keys that should be masked in responses
const SECRET_KEYS = [
  'openai_api_key',
  'deepinfra_api_key',     // NEW: Mask this key
  'openrouter_api_key',    // NEW: Mask OpenRouter key
  'anthropic_api_key',
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

// GET /api/users/prompts - The full prompt registry (every editable LLM prompt: id, category,
// label, description, placeholder vars, default text, optional warning). Used by the Settings
// "Custom prompts" editor to render one box per prompt, grouped by category, pre-filled with the
// built-in default. Per-user overrides are stored as ordinary settings under `prompt_<id>`.
router.get('/prompts', (_req, res) => {
  res.json({ prompts: PROMPT_REGISTRY });
});

export default router;
