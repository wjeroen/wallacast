import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Save, Eye, EyeOff, Key, Globe, Check, AlertCircle, Mic, FileText, Copy, Plus, Trash2, ChevronDown, ChevronRight, RefreshCw, X, Volume2, Square } from 'lucide-react';
import { userSettingsAPI, wallabagAPI, type PromptDef } from '../api';
import { useAuthStore } from '../store/authStore';
import { SPEED_CATALOG, DEFAULT_SPEEDS, parseSpeedOptions } from '../format';

interface SettingsPageProps {
  onBack: () => void;
}

// A tier maps article/comment length (in characters) to a maximum number of paragraphs ("tweets").
// The last tier uses Infinity as a catch-all for anything larger than every finite threshold.
interface SummaryTier {
  maxChars: number; // may be Infinity
  maxTweets: number;
}

const DEFAULT_SUMMARY_TIERS: SummaryTier[] = [
  { maxChars: 1500, maxTweets: 1 },
  { maxChars: 3500, maxTweets: 2 },
  { maxChars: 7000, maxTweets: 3 },
  { maxChars: 12000, maxTweets: 4 },
  { maxChars: 18000, maxTweets: 5 },
  { maxChars: 28000, maxTweets: 6 },
  { maxChars: Infinity, maxTweets: 7 },
];

// Infinity is not valid JSON, so the unbounded tier is stored as { maxChars: null }.
// Always serialize sorted (finite ascending, Infinity last) so the stored list stays sorted.
function serializeTiers(tiers: SummaryTier[]): string {
  const sorted = [...tiers].sort((a, b) => a.maxChars - b.maxChars);
  return JSON.stringify(
    sorted.map(t => ({ maxChars: Number.isFinite(t.maxChars) ? t.maxChars : null, maxTweets: t.maxTweets }))
  );
}

function parseTiers(raw: string | null | undefined): SummaryTier[] {
  if (!raw) return DEFAULT_SUMMARY_TIERS;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) return DEFAULT_SUMMARY_TIERS;
    const tiers: SummaryTier[] = (arr as Array<{ maxChars?: number | null; maxTweets?: number }>).map(t => ({
      maxChars: t.maxChars === null || t.maxChars === undefined ? Infinity : Number(t.maxChars),
      maxTweets: Math.max(1, Math.round(Number(t.maxTweets) || 1)),
    }));
    // Guarantee exactly one unbounded catch-all tier at the end
    if (!tiers.some(t => !Number.isFinite(t.maxChars))) {
      tiers.push({ maxChars: Infinity, maxTweets: 7 });
    }
    return tiers;
  } catch {
    return DEFAULT_SUMMARY_TIERS;
  }
}

// A selectable voice carries its model so the list can span TTS providers.
interface TTSVoiceChoice { model: string; voice: string; }

// Catalog of voices, grouped by provider/model. Only groups whose API key is configured
// are shown. Each voice carries its model so the rotation can span providers.
const VOICE_CATALOG: { group: string; model: string; requiresKey: 'openai' | 'deepinfra'; note?: string; voices: { id: string; label: string }[] }[] = [
  {
    group: 'gpt-4o-mini-tts (OpenAI)', model: 'gpt-4o-mini-tts', requiresKey: 'openai',
    voices: [
      { id: 'alloy', label: 'Alloy' }, { id: 'echo', label: 'Echo' }, { id: 'fable', label: 'Fable' },
      { id: 'onyx', label: 'Onyx' }, { id: 'nova', label: 'Nova' }, { id: 'shimmer', label: 'Shimmer' },
      { id: 'coral', label: 'Coral' },
    ],
  },
  {
    group: 'Kokoro-82M (DeepInfra or OpenRouter)', model: 'hexgrad/Kokoro-82M', requiresKey: 'deepinfra',
    note: 'AF/AM = American female/male, BF/BM = British female/male',
    voices: [
      { id: 'af_heart', label: 'Heart (AF)' }, { id: 'af_bella', label: 'Bella (AF)' }, { id: 'af_nicole', label: 'Nicole (AF)' },
      { id: 'am_adam', label: 'Adam (AM)' }, { id: 'am_fenrir', label: 'Fenrir (AM)' }, { id: 'am_michael', label: 'Michael (AM)' }, { id: 'am_puck', label: 'Puck (AM)' },
      { id: 'bf_emma', label: 'Emma (BF)' }, { id: 'bf_isabella', label: 'Isabella (BF)' },
      { id: 'bm_fable', label: 'Fable (BM)' }, { id: 'bm_lewis', label: 'Lewis (BM)' },
    ],
  },
];

function parseVoices(raw: string | null | undefined): TTSVoiceChoice[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const isChoice = (v: unknown): v is TTSVoiceChoice =>
      typeof v === 'object' && v !== null &&
      typeof (v as TTSVoiceChoice).model === 'string' && !!(v as TTSVoiceChoice).model &&
      typeof (v as TTSVoiceChoice).voice === 'string' && !!(v as TTSVoiceChoice).voice;
    return (arr as unknown[])
      .filter(isChoice)
      .map(v => ({ model: v.model, voice: v.voice }));
  } catch {
    return [];
  }
}

// Chat-LLM providers (all spoken to via the OpenAI-compatible API). Model is free text.
// Hints show the app's default model per provider. A blank model field uses that default
// (CHAT_DEFAULT_MODELS in backend ai-providers.ts, keep the two lists in sync).
const CHAT_PROVIDERS: Array<{ id: string; label: string; hint: string }> = [
  { id: 'openai', label: 'OpenAI', hint: 'default = gpt-5-mini' },
  { id: 'deepinfra', label: 'DeepInfra', hint: 'default = openai/gpt-oss-120b' },
  { id: 'openrouter', label: 'OpenRouter', hint: 'default = openai/gpt-5-mini' },
  { id: 'anthropic', label: 'Anthropic (Claude)', hint: 'default = claude-haiku-4-5' },
  { id: 'gemini', label: 'Google Gemini', hint: 'default = gemini-3-flash-preview' },
];
const TRANSCRIPTION_PROVIDERS: Array<{ id: string; label: string; hint: string }> = [
  { id: 'deepinfra', label: 'DeepInfra', hint: 'default = openai/whisper-large-v3-turbo' },
  { id: 'openai', label: 'OpenAI', hint: 'default = whisper-1' },
];
// Quick-pick Whisper models on DeepInfra. The Model field stays free-text for anything else,
// this dropdown just fills it in. large-v3 (full 32-layer decoder) hallucinates/loops noticeably
// less than turbo (4 layers) on long podcasts, for about 2x the (still tiny) cost.
const DEEPINFRA_WHISPER_PRESETS: Array<{ id: string; label: string }> = [
  { id: 'openai/whisper-large-v3-turbo', label: 'Whisper large-v3-turbo (cheaper)' },
  { id: 'openai/whisper-large-v3', label: 'Whisper large-v3 (full)' },
];
const chatHintFor = (provider: string) => CHAT_PROVIDERS.find(p => p.id === provider)?.hint || 'model name';
// Effective default model per image-description provider. Used to pre-fill the model field and
// to swap it when the provider changes, so a Gemini id never gets sent to DeepInfra.
const IMAGE_MODEL_DEFAULTS: Record<string, string> = {
  gemini: 'gemini-3-flash-preview',
  deepinfra: 'google/gemma-4-26B-A4B-it',
  openai: 'gpt-5-mini',
  openrouter: 'google/gemini-3-flash-preview',
};
// Default chat model per provider (mirror of CHAT_DEFAULT_MODELS in backend ai-providers.ts).
const CHAT_MODEL_DEFAULTS: Record<string, string> = {
  openai: 'gpt-5-mini',
  deepinfra: 'openai/gpt-oss-120b',
  openrouter: 'openai/gpt-5-mini',
  anthropic: 'claude-haiku-4-5',
  gemini: 'gemini-3-flash-preview',
};

export function SettingsPage({ onBack }: SettingsPageProps) {
  const { user, logout } = useAuthStore();
  // The shared demo account may look at every setting but change none. Inputs are
  // disabled via a fieldset wrapper below, and the backend blocks writes regardless.
  const isDemo = !!user?.demo;
  const [settings, setSettings] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});

  // Summary length tiers (editable, sorted list). Infinity tier is always last.
  const [summaryTiers, setSummaryTiers] = useState<SummaryTier[]>(DEFAULT_SUMMARY_TIERS);
  const [showLengthSettings, setShowLengthSettings] = useState(false);
  const [showWallabagHelp, setShowWallabagHelp] = useState(false);

  // Custom prompts (advanced). The backend registry lists every editable LLM prompt with its
  // built-in default; `promptValues` holds the current textarea content keyed by setting key
  // (`prompt_<id>`), pre-filled with the saved override or the default. On save, a value equal to
  // the default is stored empty = "use built-in default". Categories are independently collapsible.
  const [showCustomPrompts, setShowCustomPrompts] = useState(false);
  const [prompts, setPrompts] = useState<PromptDef[]>([]);
  const [promptValues, setPromptValues] = useState<Record<string, string>>({});
  const [openPromptCats, setOpenPromptCats] = useState<Record<string, boolean>>({});
  const promptKey = (id: string) => `prompt_${id}`;

  // Multiple voices to rotate between for audio generation (empty = use the single voice above).
  const [ttsVoices, setTtsVoices] = useState<TTSVoiceChoice[]>([]);

  // Speeds the player's speed button cycles through.
  const [speedOptions, setSpeedOptions] = useState<number[]>(DEFAULT_SPEEDS);

  // Wallabag connection state
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'untested' | 'success' | 'failed'>('untested');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [wallabagStatus, setWallabagStatus] = useState<{
    enabled: boolean;
    lastSync: string | null;
    pendingChanges: number;
  } | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Form state
  const [formData, setFormData] = useState({
    // AI Settings
    openai_api_key: '',

    // DeepInfra Settings
    deepinfra_api_key: '',
    openrouter_api_key: '',
    anthropic_api_key: '',

    // Narration LLM (legacy; per-job config below supersedes it)
    narration_llm: 'auto',

    // Per-job model config (provider + free-text model + reasoning effort).
    // narration_* pre-fill from narration_llm on load; alignment/summary default to "same as narration".
    narration_provider: 'openai', narration_model: '', narration_reasoning_effort: '',
    alignment_same_as_narration: 'true', alignment_provider: 'openai', alignment_model: '', alignment_reasoning_effort: '',
    summary_same_as_narration: 'true', summary_provider: 'openai', summary_model: '', summary_reasoning_effort: '',
    // Transcription (Whisper): provider deepinfra | openai | openrouter
    transcription_provider: 'deepinfra', transcription_model: '',
    // Route Kokoro TTS voices via DeepInfra (default) or via OpenRouter (same voices).
    kokoro_tts_provider: 'deepinfra',

    // Image alt-text: provider gemini | deepinfra | openai | openrouter
    gemini_api_key: '',
    image_alt_text_enabled: 'true',
    image_alt_text_provider: 'gemini',
    image_alt_text_model: '',

    auto_transcribe_podcasts: 'true',
    auto_generate_audio_for_articles: 'false',
    generate_read_along: 'true',
    // Summaries
    auto_generate_summary: 'false',
    auto_generate_summary_audio: 'false',
    summarize_comments: 'true',
    summary_max_words: '40',
    library_show_summary: 'false',
    copy_include_summary: 'false',
    copy_include_comment_summary: 'true',
    copy_summary_code_label: '',
    copy_include_comments: 'true',
    narrate_ea_forum_comments: 'true',
    narrate_substack_comments: 'true',
    max_narrated_comments: '50',
    manual_queue_always_autoplay: 'true',
    autoplay_on_open: 'false',
    show_continue_listening: 'true',
    warn_archive_removes_audio: 'true',
    // Wallabag Settings
    wallabag_url: '',
    wallabag_client_id: '',
    wallabag_client_secret: '',
    wallabag_username: '',
    wallabag_password: '',
    wallabag_sync_enabled: 'false',
  });

  useEffect(() => {
    loadSettings();
    loadWallabagStatus();
  }, []);

  const loadWallabagStatus = async () => {
    try {
      const response = await wallabagAPI.getStatus();
      setWallabagStatus(response.data);
    } catch (err) {
      console.error('Failed to load Wallabag status:', err);
    }
  };

  const loadSettings = async () => {
    try {
      setLoading(true);
      const [settingsRes, promptsRes] = await Promise.all([
        userSettingsAPI.getAll(),
        // The editable-prompt registry is nice-to-have; if it fails the editor just stays empty.
        userSettingsAPI.getPrompts().catch(() => null),
      ]);
      setSettings(settingsRes.data.settings);

      const loaded = settingsRes.data.settings;

      // Editable-prompt registry: pre-fill each box with the saved override, else the built-in
      // default, so a box is never blank and the user always edits from a real starting point.
      const registry = promptsRes?.data.prompts || [];
      setPrompts(registry);
      const pv: Record<string, string> = {};
      for (const p of registry) {
        const saved = loaded[promptKey(p.id)];
        pv[promptKey(p.id)] = saved && saved.trim() ? saved : p.default;
      }
      setPromptValues(pv);

      // Derive the per-job defaults from the legacy narration_llm routing (pre-fill).
      const hasDeepInfraKey = !!loaded.deepinfra_api_key; // masked dots or real value are both truthy
      const deriveLegacy = (llm: string) => {
        if (llm === 'openai-mini' || llm === 'openai') return { provider: 'openai', model: CHAT_MODEL_DEFAULTS.openai };
        if (llm === 'deepseek') return { provider: 'deepinfra', model: 'deepseek-ai/DeepSeek-V3.2' };
        // 'auto': first provider with a configured key, in recommendation order (GPT-5 Mini first).
        const keyByProvider: Array<[string, unknown]> = [
          ['openai', loaded.openai_api_key], ['deepinfra', loaded.deepinfra_api_key],
          ['anthropic', loaded.anthropic_api_key], ['gemini', loaded.gemini_api_key],
          ['openrouter', loaded.openrouter_api_key],
        ];
        const found = keyByProvider.find(([, key]) => !!key)?.[0] || 'openai';
        return { provider: found, model: CHAT_MODEL_DEFAULTS[found] };
      };
      const legacyNarration = deriveLegacy(loaded.narration_llm || 'auto');
      const boolDefault = (v: string | null | undefined, d: string) => (v !== undefined && v !== null ? v : d);

      // Pre-fill transcription/image model fields with the effective default (the model the
      // backend actually uses when the field is blank), so they show the model in use, just as
      // the narration fields pre-fill from the legacy routing.
      // 'openrouter' was removed as a transcription provider (its endpoint returns no word
      // timestamps, which read-along needs), so map any old saved value to a working one.
      const savedTransProvider = loaded.transcription_provider === 'openrouter' ? '' : loaded.transcription_provider;
      const transProvider = savedTransProvider || (hasDeepInfraKey ? 'deepinfra' : 'openai');
      // Image provider default is key-aware (mirror of defaultImageProvider() in image-alt-text.ts).
      const defaultImageProvider = loaded.gemini_api_key ? 'gemini'
        : loaded.deepinfra_api_key ? 'deepinfra'
        : loaded.openai_api_key ? 'openai'
        : loaded.openrouter_api_key ? 'openrouter' : 'gemini';

      setFormData(prev => ({
        ...prev,
        openai_api_key: loaded.openai_api_key === '••••••••' ? '' : (loaded.openai_api_key || ''),

        deepinfra_api_key: loaded.deepinfra_api_key === '••••••••' ? '' : (loaded.deepinfra_api_key || ''),
        openrouter_api_key: loaded.openrouter_api_key === '••••••••' ? '' : (loaded.openrouter_api_key || ''),
        anthropic_api_key: loaded.anthropic_api_key === '••••••••' ? '' : (loaded.anthropic_api_key || ''),

        narration_llm: loaded.narration_llm || 'auto',

        // Providers pre-fill so the dropdowns have a sensible value. Model fields stay blank
        // unless explicitly saved: blank = the live default (the placeholder shows which),
        // so defaults are never pinned into user settings just by hitting Save.
        narration_provider: loaded.narration_provider || legacyNarration.provider,
        narration_model: loaded.narration_model || '',
        narration_reasoning_effort: loaded.narration_reasoning_effort || '',
        alignment_same_as_narration: boolDefault(loaded.alignment_same_as_narration, 'true'),
        alignment_provider: loaded.alignment_provider || legacyNarration.provider,
        alignment_model: loaded.alignment_model || '',
        alignment_reasoning_effort: loaded.alignment_reasoning_effort || '',
        summary_same_as_narration: boolDefault(loaded.summary_same_as_narration, 'true'),
        summary_provider: loaded.summary_provider || legacyNarration.provider,
        summary_model: loaded.summary_model || '',
        summary_reasoning_effort: loaded.summary_reasoning_effort || '',
        transcription_provider: transProvider,
        transcription_model: loaded.transcription_model || '',
        kokoro_tts_provider: loaded.kokoro_tts_provider || 'deepinfra',

        gemini_api_key: loaded.gemini_api_key === '••••••••' ? '' : (loaded.gemini_api_key || ''),
        image_alt_text_enabled: loaded.image_alt_text_enabled !== undefined && loaded.image_alt_text_enabled !== null ? loaded.image_alt_text_enabled : 'true',
        image_alt_text_provider: loaded.image_alt_text_provider || defaultImageProvider,
        image_alt_text_model: loaded.image_alt_text_model || '',

        auto_transcribe_podcasts: loaded.auto_transcribe_podcasts !== undefined && loaded.auto_transcribe_podcasts !== null ? loaded.auto_transcribe_podcasts : 'true',
        auto_generate_audio_for_articles: loaded.auto_generate_audio_for_articles !== undefined && loaded.auto_generate_audio_for_articles !== null ? loaded.auto_generate_audio_for_articles : 'false',
        generate_read_along: loaded.generate_read_along !== undefined && loaded.generate_read_along !== null ? loaded.generate_read_along : 'true',
        auto_generate_summary: loaded.auto_generate_summary !== undefined && loaded.auto_generate_summary !== null ? loaded.auto_generate_summary : 'false',
        auto_generate_summary_audio: loaded.auto_generate_summary_audio !== undefined && loaded.auto_generate_summary_audio !== null ? loaded.auto_generate_summary_audio : 'false',
        summarize_comments: loaded.summarize_comments !== undefined && loaded.summarize_comments !== null ? loaded.summarize_comments : 'true',
        summary_max_words: loaded.summary_max_words || '40',
        library_show_summary: loaded.library_show_summary !== undefined && loaded.library_show_summary !== null ? loaded.library_show_summary : 'false',
        copy_include_summary: loaded.copy_include_summary !== undefined && loaded.copy_include_summary !== null ? loaded.copy_include_summary : 'false',
        copy_include_comment_summary: loaded.copy_include_comment_summary !== undefined && loaded.copy_include_comment_summary !== null ? loaded.copy_include_comment_summary : 'true',
        copy_summary_code_label: loaded.copy_summary_code_label || '',
        copy_include_comments: loaded.copy_include_comments !== undefined && loaded.copy_include_comments !== null ? loaded.copy_include_comments : 'true',
        narrate_ea_forum_comments: loaded.narrate_ea_forum_comments !== undefined && loaded.narrate_ea_forum_comments !== null ? loaded.narrate_ea_forum_comments : 'true',
        narrate_substack_comments: loaded.narrate_substack_comments !== undefined && loaded.narrate_substack_comments !== null ? loaded.narrate_substack_comments : 'true',
        max_narrated_comments: loaded.max_narrated_comments || '50',
        manual_queue_always_autoplay: loaded.manual_queue_always_autoplay !== undefined && loaded.manual_queue_always_autoplay !== null ? loaded.manual_queue_always_autoplay : 'true',
        show_continue_listening: loaded.show_continue_listening !== undefined && loaded.show_continue_listening !== null ? loaded.show_continue_listening : 'true',
        warn_archive_removes_audio: loaded.warn_archive_removes_audio !== undefined && loaded.warn_archive_removes_audio !== null ? loaded.warn_archive_removes_audio : 'true',
        wallabag_url: loaded.wallabag_url || '',
        wallabag_client_id: loaded.wallabag_client_id || '',
        wallabag_client_secret: loaded.wallabag_client_secret === '••••••••' ? '' : (loaded.wallabag_client_secret || ''),
        wallabag_username: loaded.wallabag_username || '',
        wallabag_password: loaded.wallabag_password === '••••••••' ? '' : (loaded.wallabag_password || ''),
        wallabag_sync_enabled: loaded.wallabag_sync_enabled !== undefined && loaded.wallabag_sync_enabled !== null ? loaded.wallabag_sync_enabled : 'false',
      }));

      setSummaryTiers(parseTiers(loaded.summary_tiers));
      setTtsVoices(parseVoices(loaded.tts_voices));
      setSpeedOptions(parseSpeedOptions(loaded.playback_speed_options));
    } catch (err) {
      setError('Failed to load settings');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (key: string, value: string) => {
    setFormData(prev => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  // Renders a chat-LLM job (provider dropdown + free-text model + reasoning effort).
  // `base` = the Narration job (no "same as" checkbox); others can defer to it.
  const renderChatJob = (job: 'narration' | 'alignment' | 'summary', title: string, description: string, base = false) => {
    const fd = formData as Record<string, string>;
    const provider = fd[`${job}_provider`] || 'openai';
    const sameKey = `${job}_same_as_narration`;
    const usingSame = !base && fd[sameKey] === 'true';
    return (
      <div className="form-group ai-job" key={job}>
        <label>{title}</label>
        {description && <small className="settings-hint" style={base ? { marginBottom: '0.5rem' } : undefined}>{description}</small>}
        {!base && (
          <label className="checkbox-inline" style={{ marginTop: '0.5rem', marginBottom: usingSame ? 0 : '0.5rem' }}>
            <input type="checkbox" checked={fd[sameKey] === 'true'} onChange={(e) => handleChange(sameKey, e.target.checked ? 'true' : 'false')} />
            Use the same model as Narration
          </label>
        )}
        {(base || !usingSame) && (
          <div className="ai-job-fields">
            <div className="ai-field">
              <span className="ai-field-label">Provider</span>
              <select value={provider} onChange={(e) => handleChange(`${job}_provider`, e.target.value)}>
                {CHAT_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </div>
            <div className="ai-field">
              <span className="ai-field-label">Model</span>
              <input
                type="text"
                value={fd[`${job}_model`] || ''}
                onChange={(e) => handleChange(`${job}_model`, e.target.value)}
                placeholder={chatHintFor(provider)}
              />
            </div>
            <div className="ai-field">
              <span className="ai-field-label">Reasoning effort</span>
              <input
                type="text"
                value={fd[`${job}_reasoning_effort`] || ''}
                onChange={(e) => handleChange(`${job}_reasoning_effort`, e.target.value)}
                placeholder={provider === 'openai' ? 'default = medium' : provider === 'anthropic' ? 'off / low / medium / high / xhigh / max (default = high)' : 'blank = model default'}
              />
            </div>
          </div>
        )}
      </div>
    );
  };

  // --- Summary tier editor helpers ---
  const updateTier = (index: number, field: 'maxChars' | 'maxTweets', raw: string) => {
    const num = parseInt(raw, 10);
    setSummaryTiers(prev => prev.map((t, i) => {
      if (i !== index) return t;
      if (Number.isNaN(num)) return { ...t, [field]: field === 'maxTweets' ? 1 : 0 };
      return { ...t, [field]: field === 'maxTweets' ? Math.max(1, num) : Math.max(0, num) };
    }));
    setSaved(false);
  };

  const addTier = () => {
    setSummaryTiers(prev => {
      const finite = prev.filter(t => Number.isFinite(t.maxChars));
      const infinity = prev.find(t => !Number.isFinite(t.maxChars)) || { maxChars: Infinity, maxTweets: 7 };
      const lastFinite = finite.length ? finite[finite.length - 1] : { maxChars: 1000, maxTweets: 1 };
      const newTier: SummaryTier = {
        maxChars: lastFinite.maxChars + 5000,
        maxTweets: Math.min(infinity.maxTweets, lastFinite.maxTweets + 1),
      };
      return [...finite, newTier, infinity];
    });
    setSaved(false);
  };

  const removeTier = (index: number) => {
    setSummaryTiers(prev => {
      // Never remove the unbounded catch-all tier
      if (!Number.isFinite(prev[index]?.maxChars)) return prev;
      return prev.filter((_, i) => i !== index);
    });
    setSaved(false);
  };

  // --- Voice previews ---
  // Static sample mp3s generated by frontend/scripts/generate-voice-previews.mjs
  // (one short sentence per voice). The file name convention must match fileFor()
  // in that script.
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [playingPreview, setPlayingPreview] = useState<string | null>(null);
  const playVoicePreview = (model: string, voice: string, e: React.MouseEvent) => {
    // The button lives inside the chip's <label>: without preventDefault the
    // click would also toggle the voice checkbox.
    e.preventDefault();
    e.stopPropagation();
    const key = `${model}:${voice}`;
    if (!previewAudioRef.current) previewAudioRef.current = new Audio();
    const audio = previewAudioRef.current;
    if (playingPreview === key) {
      audio.pause();
      setPlayingPreview(null);
      return;
    }
    audio.src = `/voice-previews/${model.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}--${voice}.mp3`;
    audio.onended = () => setPlayingPreview(null);
    audio.onerror = () => setPlayingPreview(null);
    audio.play().then(() => setPlayingPreview(key)).catch(() => setPlayingPreview(null));
  };

  const toggleSpeedOption = (s: number) => {
    setSpeedOptions(prev =>
      prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s].sort((a, b) => a - b)
    );
    setSaved(false);
  };

  // --- Voice rotation helpers ---
  const isVoiceSelected = (model: string, voice: string) =>
    ttsVoices.some(v => v.model === model && v.voice === voice);

  const toggleVoice = (model: string, voice: string) => {
    setTtsVoices(prev =>
      prev.some(v => v.model === model && v.voice === voice)
        ? prev.filter(v => !(v.model === model && v.voice === voice))
        : [...prev, { model, voice }]
    );
    setSaved(false);
  };

  const handleSave = async () => {
    if (isDemo) return;
    try {
      setSaving(true);
      setError(null);

      // Per-job config + the "same as narration" toggles must save even when empty/false
      // (so clearing a model or unticking a box actually takes effect).
      const alwaysSave = new Set([
        'auto_transcribe_podcasts', 'auto_generate_audio_for_articles', 'auto_generate_summary',
        'auto_generate_summary_audio',
        'summarize_comments', 'library_show_summary', 'copy_include_summary', 'copy_include_comment_summary', 'copy_summary_code_label', 'copy_include_comments', 'wallabag_sync_enabled', 'image_alt_text_enabled',
        'narrate_ea_forum_comments', 'narrate_substack_comments', 'manual_queue_always_autoplay', 'autoplay_on_open',
        'show_continue_listening', 'warn_archive_removes_audio', 'generate_read_along',
        'narration_provider', 'narration_model', 'narration_reasoning_effort',
        'alignment_same_as_narration', 'alignment_provider', 'alignment_model', 'alignment_reasoning_effort',
        'summary_same_as_narration', 'summary_provider', 'summary_model', 'summary_reasoning_effort',
        'transcription_provider', 'transcription_model', 'kokoro_tts_provider',
        'image_alt_text_provider', 'image_alt_text_model',
      ]);

      const toSave: Record<string, string> = {};
      for (const [key, value] of Object.entries(formData)) {
        if (alwaysSave.has(key)) {
          toSave[key] = value;
        } else if (value && value !== '' && value !== '••••••••') {
          toSave[key] = value;
        }
      }

      // Summary tiers are managed in their own state, and we serialize (Infinity -> null) on save.
      toSave.summary_tiers = serializeTiers(summaryTiers);

      // Custom prompts: store empty when blank OR identical to the built-in default, so we never
      // pin the current default text (the backend falls back to its own default for empty values,
      // letting future default improvements flow through). Always sent so clearing one takes effect.
      for (const p of prompts) {
        const key = promptKey(p.id);
        const val = (promptValues[key] || '').trim();
        toSave[key] = val && val !== (p.default || '').trim() ? val : '';
      }
      // Selected rotation voices (empty array = always use the single voice).
      toSave.tts_voices = JSON.stringify(ttsVoices);
      // Speed cycle: blank = default set, never pinned (so default changes reach everyone).
      toSave.playback_speed_options =
        JSON.stringify(speedOptions) === JSON.stringify(DEFAULT_SPEEDS) ? '' : JSON.stringify(speedOptions);

      await userSettingsAPI.setBulk(toSave);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await loadSettings();
    } catch (err) {
      setError('Failed to save settings');
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const toggleShowSecret = (key: string) => {
    setShowSecrets(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const isSecretSet = (key: string) => {
    return settings[key] === '••••••••';
  };

  // Clear a stored API key. The backend stores '' which it treats as unset everywhere.
  const removeApiKey = async (key: string, label: string) => {
    if (!confirm(`Remove your ${label}?`)) return;
    try {
      await userSettingsAPI.setBulk({ [key]: '' });
      await loadSettings();
    } catch (err) {
      setError('Failed to remove the key');
      console.error(err);
    }
  };

  const handleTestConnection = async () => {
    setTestingConnection(true);
    setConnectionStatus('untested');
    setConnectionError(null);
    try {
      const response = await wallabagAPI.testConnection();
      if (response.data.success) {
        setConnectionStatus('success');
        await loadWallabagStatus();
      } else {
        setConnectionStatus('failed');
        setConnectionError(response.data.error || 'Connection failed');
      }
    } catch (err) {
      setConnectionStatus('failed');
      setConnectionError('Connection test failed. Check console for details.');
      console.error('Test connection error:', err);
    } finally {
      setTestingConnection(false);
    }
  };

  const handleCleanup = async () => {
    if (!confirm('Delete recently synced items (last 2 hours)? This will delete items that are NOT starred and do NOT have audio.')) {
      return;
    }

    setSyncing(true);
    setConnectionError(null);

    try {
      const response = await wallabagAPI.cleanup(2);
      alert(`Deleted ${response.data.deleted} items`);
    } catch (err) {
      setConnectionError('Cleanup failed. Check console for details.');
      console.error('Cleanup error:', err);
    } finally {
      setSyncing(false);
    }
  };

  const handleFullRefresh = async () => {
    if (!confirm('Fetch ALL items from Wallabag? This ignores the last sync timestamp and can take a while if you have many articles.')) {
      return;
    }

    setSyncing(true);
    setConnectionError(null);

    try {
      const response = await wallabagAPI.fullRefresh();
      alert(`Full refresh complete! Pulled ${response.data.pulled} items`);
      await loadWallabagStatus();
    } catch (err) {
      setConnectionError('Full refresh failed. Check console for details.');
      console.error('Full refresh error:', err);
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return (
      <div className="settings-page">
        <header className="settings-header">
          <button onClick={onBack} className="back-button"><ArrowLeft size={24} /></button>
          <h2>Settings</h2>
        </header>
        <div className="settings-loading">Loading settings...</div>
      </div>
    );
  }

  const hasOpenAIKey = isSecretSet('openai_api_key') || !!formData.openai_api_key.trim();
  const hasDeepInfraKey = isSecretSet('deepinfra_api_key') || !!formData.deepinfra_api_key.trim();
  const hasOpenRouterKey = isSecretSet('openrouter_api_key') || !!formData.openrouter_api_key.trim();
  // OpenAI voices need an OpenAI key (OpenRouter does not carry the OpenAI TTS models).
  // Kokoro voices are usable with either a DeepInfra key or an OpenRouter key (the "Kokoro
  // voices via" toggle just picks which one synthesizes them), so flipping it never hides them.
  const canUseKokoroVoices = hasDeepInfraKey || hasOpenRouterKey;
  const availableVoiceGroups = VOICE_CATALOG.filter(g =>
    g.requiresKey === 'openai' ? hasOpenAIKey : canUseKokoroVoices
  );
  const hasAnthropicKey = isSecretSet('anthropic_api_key') || !!formData.anthropic_api_key.trim();
  const hasGeminiKey = isSecretSet('gemini_api_key') || !!formData.gemini_api_key.trim();
  // Feature availability by configured keys, shown in the Account section so new users see
  // what already works and which key unlocks the rest.
  const featureAccess = [
    { name: 'Narration scripts, read-along alignment and summaries', ok: hasOpenAIKey || hasDeepInfraKey || hasOpenRouterKey || hasAnthropicKey || hasGeminiKey, needs: 'any API key' },
    { name: 'Audio narration (TTS voices)', ok: hasOpenAIKey || canUseKokoroVoices, needs: 'an OpenAI, DeepInfra, or OpenRouter key' },
    { name: 'Podcast transcription', ok: hasDeepInfraKey || hasOpenAIKey, needs: 'a DeepInfra or OpenAI key' },
    { name: 'Image descriptions', ok: hasDeepInfraKey || hasGeminiKey || hasOpenRouterKey || hasOpenAIKey, needs: 'a DeepInfra, OpenAI, Gemini, or OpenRouter key' },
  ];
  const allFeaturesAvailable = featureAccess.every(f => f.ok);

  return (
    <div className="settings-page">
      <header className="settings-header">
        <button onClick={onBack} className="back-button">
          <ArrowLeft size={24} />
        </button>
        <h2>Settings</h2>
        <button
          onClick={handleSave}
          className={`save-button ${saved ? 'saved' : ''}`}
          disabled={saving || isDemo}
          title={isDemo ? 'Settings are read-only in the demo' : undefined}
        >
          {saved ? <Check size={18} /> : <Save size={18} />}
          <span>{saving ? 'Saving...' : saved ? 'Saved' : 'Save'}</span>
        </button>
      </header>

      {isDemo && (
        <p className="section-description" style={{ padding: '0 1rem', marginTop: '0.5rem' }}>
          This is the read-only demo, so settings can be browsed but not changed.
        </p>
      )}

      {error && (
        <div className="settings-error">
          <AlertCircle size={18} />
          <span>{error}</span>
        </div>
      )}

      <div className="settings-content">
        {/* User Info */}
        <section className="settings-section">
          <h3>Account</h3>
          <div className="user-info">
            <div className="user-avatar">
              {(user?.display_name || user?.username || 'U').charAt(0).toUpperCase()}
            </div>
            <div className="user-details">
              <span className="user-name">{user?.display_name || user?.username}</span>
              <span className="user-username">@{user?.username}</span>
            </div>
            <button onClick={logout} className="logout-button">
              Sign Out
            </button>
          </div>
          {allFeaturesAvailable ? (
            <div className="feature-access-all">
              <Check size={16} /> All features available
            </div>
          ) : (
            <div className="feature-access">
              {featureAccess.map(f => (
                <div key={f.name} className={`feature-access-row ${f.ok ? 'ok' : 'missing'}`}>
                  {f.ok ? <Check size={16} /> : <X size={16} />}
                  <span>{f.name}{!f.ok && <> (needs {f.needs})</>}</span>
                </div>
              ))}
              <button
                type="button"
                className="feature-access-link"
                onClick={() => document.getElementById('api-keys-section')?.scrollIntoView({ behavior: 'smooth' })}
              >
                Add keys in the API keys section
              </button>
            </div>
          )}
        </section>

        {/* Everything below the Account section goes inert for the read-only demo:
            a disabled fieldset natively disables every input/select/button inside it.
            The Account section stays outside so Sign Out keeps working. */}
        <fieldset className="settings-demo-fieldset" disabled={isDemo}>

        {/* Audio Generation Section: what gets turned into audio automatically.
            Model/voice choices live in the Models section further down. */}
        <section className="settings-section">
           <h3><Mic size={20} /> Audio generation</h3>

           <div className="form-group checkbox-group">
              <label>
                <input
                  type="checkbox"
                  checked={formData.auto_generate_audio_for_articles === 'true'}
                  onChange={(e) => handleChange('auto_generate_audio_for_articles', e.target.checked ? 'true' : 'false')}
                />
                Auto-generate audio for articles
              </label>
           </div>

           <div className="form-group checkbox-group">
              <label>
                <input
                  type="checkbox"
                  checked={formData.auto_transcribe_podcasts === 'true'}
                  onChange={(e) => handleChange('auto_transcribe_podcasts', e.target.checked ? 'true' : 'false')}
                />
                Auto-transcribe podcasts
              </label>
           </div>

           <div className="form-group checkbox-group">
              <label>
                <input
                  type="checkbox"
                  checked={formData.generate_read_along === 'true'}
                  onChange={(e) => handleChange('generate_read_along', e.target.checked ? 'true' : 'false')}
                />
                Generate read-along after audio
              </label>
              <small className="settings-hint indent">
                Off = audio only, no transcription or highlighting. You can still add read-along per item via Regenerate transcript.
              </small>
           </div>

           <div className="form-group checkbox-group">
              <label>
                <input
                  type="checkbox"
                  checked={formData.narrate_ea_forum_comments === 'true'}
                  onChange={(e) => handleChange('narrate_ea_forum_comments', e.target.checked ? 'true' : 'false')}
                />
                Narrate EA Forum / LessWrong comments
              </label>
           </div>

           <div className="form-group checkbox-group">
              <label>
                <input
                  type="checkbox"
                  checked={formData.narrate_substack_comments === 'true'}
                  onChange={(e) => handleChange('narrate_substack_comments', e.target.checked ? 'true' : 'false')}
                />
                Narrate Substack comments
              </label>
           </div>

           {(formData.narrate_ea_forum_comments === 'true' || formData.narrate_substack_comments === 'true') && (
             <div className="form-group" style={{ marginLeft: '1.5rem' }}>
               <label style={{ fontSize: '0.9rem' }}>
                 No auto-generating articles with over
                 <input
                   type="number"
                   min="1"
                   max="9999"
                   value={formData.max_narrated_comments}
                   onChange={(e) => handleChange('max_narrated_comments', e.target.value)}
                   style={{ marginLeft: '0.5rem', marginRight: '0.5rem', width: '5rem' }}
                 />
                 comments
               </label>
               <small className="settings-hint">
                 Includes replies. You can still generate these articles manually.
               </small>
             </div>
           )}
        </section>

        {/* Playback / Queue Settings */}
        <section className="settings-section">
          <h3>Playback</h3>

          <div className="form-group checkbox-group">
            <label>
              <input
                type="checkbox"
                checked={formData.manual_queue_always_autoplay === 'true'}
                onChange={(e) => handleChange('manual_queue_always_autoplay', e.target.checked ? 'true' : 'false')}
              />
              Manually queued items always autoplay
            </label>
            <small className="settings-hint indent">
              When on, items you explicitly added to the queue auto-advance regardless of the autoplay toggle.
              Turn off if you only want anything to auto-advance when the player's autoplay toggle is on.
            </small>
          </div>

          <div className="form-group checkbox-group">
            <label>
              <input
                type="checkbox"
                checked={formData.autoplay_on_open === 'true'}
                onChange={(e) => handleChange('autoplay_on_open', e.target.checked ? 'true' : 'false')}
              />
              Start playing when opening an item
            </label>
            <small className="settings-hint indent">
              When on, clicking a library item starts its audio right away instead of waiting for play.
            </small>
          </div>

          <div className="form-group checkbox-group">
            <label>
              <input
                type="checkbox"
                checked={formData.show_continue_listening === 'true'}
                onChange={(e) => handleChange('show_continue_listening', e.target.checked ? 'true' : 'false')}
              />
              Show the continue-listening row in the library
            </label>
          </div>

          <div className="form-group checkbox-group">
            <label>
              <input
                type="checkbox"
                checked={formData.warn_archive_removes_audio === 'true'}
                onChange={(e) => handleChange('warn_archive_removes_audio', e.target.checked ? 'true' : 'false')}
              />
              Warn when archiving removes generated audio
            </label>
          </div>

          <div className="form-group">
            <label>Speed button options</label>
            <small className="settings-hint">
              Which speeds the player's speed button cycles through. None selected = the default set.
            </small>
            <div className="voice-grid" style={{ marginTop: '0.5rem' }}>
              {SPEED_CATALOG.map(s => (
                <label key={s} className={`voice-chip ${speedOptions.includes(s) ? 'selected' : ''}`}>
                  <input
                    type="checkbox"
                    checked={speedOptions.includes(s)}
                    onChange={() => toggleSpeedOption(s)}
                  />
                  {s}x
                </label>
              ))}
            </div>
          </div>
        </section>

        {/* Summaries Section */}
        <section className="settings-section">
          <h3><FileText size={20} /> Summaries</h3>

          <div className="form-group checkbox-group">
            <label>
              <input
                type="checkbox"
                checked={formData.auto_generate_summary === 'true'}
                onChange={(e) => handleChange('auto_generate_summary', e.target.checked ? 'true' : 'false')}
              />
              Auto-generate a summary when an article is added
            </label>
          </div>

          <div className="form-group checkbox-group">
            <label>
              <input
                type="checkbox"
                checked={formData.auto_generate_summary_audio === 'true'}
                onChange={(e) => handleChange('auto_generate_summary_audio', e.target.checked ? 'true' : 'false')}
              />
              Auto-generate audio for summaries
            </label>
            <small className="settings-hint indent">
              Turns every new summary into a short audio version. The player's playback options have a "Prefer summary audio" toggle to play it instead of the full audio.
            </small>
          </div>

          <div className="form-group checkbox-group">
            <label>
              <input
                type="checkbox"
                checked={formData.summarize_comments === 'true'}
                onChange={(e) => handleChange('summarize_comments', e.target.checked ? 'true' : 'false')}
              />
              Also summarize comments
            </label>
            <small className="settings-hint indent">
              Adds a separate comment-discussion summary below the article summary.
            </small>
          </div>

          <div className="form-group checkbox-group">
            <label>
              <input
                type="checkbox"
                checked={formData.library_show_summary === 'true'}
                onChange={(e) => handleChange('library_show_summary', e.target.checked ? 'true' : 'false')}
              />
              Show summaries on library cards
            </label>
            <small className="settings-hint indent">
              Replaces each library card's description with its article summary. Falls back to the description when no summary exists.
            </small>
          </div>

          <button
            type="button"
            className="settings-collapse-toggle"
            onClick={() => setShowLengthSettings(v => !v)}
            aria-expanded={showLengthSettings}
          >
            {showLengthSettings ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <span>Length settings</span>
          </button>

          {showLengthSettings && (
            <div className="settings-collapse-body">
              <div className="form-group">
                <label>Words per paragraph</label>
                <input
                  type="number"
                  min="5"
                  max="500"
                  value={formData.summary_max_words}
                  onChange={(e) => handleChange('summary_max_words', e.target.value)}
                  style={{ width: '7rem' }}
                />
                <small className="settings-hint">
                  Max number of words in each paragraph.
                </small>
              </div>

              <div className="form-group">
                <label>Summary length tiers</label>
                <small className="settings-hint" style={{ marginBottom: '0.5rem' }}>
                  Longer content gets more paragraphs. The character count is measured automatically, the matching
                  tier sets the maximum number of paragraphs.
                </small>
                <div className="summary-tiers-editor">
                  <div className="summary-tier-row summary-tier-header">
                    <span>Up to (characters)</span>
                    <span>Max paragraphs</span>
                    <span></span>
                  </div>
                  {summaryTiers.map((tier, index) => {
                    const isInfinity = !Number.isFinite(tier.maxChars);
                    return (
                      <div className="summary-tier-row" key={index}>
                        {isInfinity ? (
                          <span className="summary-tier-infinity">Anything larger</span>
                        ) : (
                          <input
                            type="number"
                            min="1"
                            value={tier.maxChars}
                            onChange={(e) => updateTier(index, 'maxChars', e.target.value)}
                          />
                        )}
                        <input
                          type="number"
                          min="1"
                          value={tier.maxTweets}
                          onChange={(e) => updateTier(index, 'maxTweets', e.target.value)}
                        />
                        {isInfinity ? (
                          <span></span>
                        ) : (
                          <button type="button" className="summary-tier-remove" title="Remove tier" onClick={() => removeTier(index)}>
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                <button type="button" className="summary-tier-add" onClick={addTier}>
                  <Plus size={16} /> Add tier
                </button>
              </div>
            </div>
          )}

        </section>

        {/* Copy & export: what leaves the app through the "Copy content" action */}
        <section className="settings-section">
          <h3><Copy size={20} /> Copy & export</h3>
          <p className="section-description">
            What the "Copy content" action adds to the article text.
          </p>

          <div className="form-group checkbox-group">
            <label>
              <input
                type="checkbox"
                checked={formData.copy_include_summary === 'true'}
                onChange={(e) => handleChange('copy_include_summary', e.target.checked ? 'true' : 'false')}
              />
              Summary
            </label>
            <small className="settings-hint indent">
              At the top, in a code block.
            </small>
          </div>
          {formData.copy_include_summary === 'true' && (
            <div className="settings-indent">
              <div className="form-group checkbox-group">
                <label>
                  <input
                    type="checkbox"
                    checked={formData.copy_include_comment_summary === 'true'}
                    onChange={(e) => handleChange('copy_include_comment_summary', e.target.checked ? 'true' : 'false')}
                  />
                  Comment summary
                </label>
                <small className="settings-hint indent">
                  A second code block, right after the summary.
                </small>
              </div>
              <div className="form-group">
                <label htmlFor="copy_summary_code_label">Code block label</label>
                <input
                  id="copy_summary_code_label"
                  type="text"
                  value={formData.copy_summary_code_label}
                  onChange={(e) => handleChange('copy_summary_code_label', e.target.value)}
                  placeholder="none"
                  autoCapitalize="off"
                  autoCorrect="off"
                />
                <small className="settings-hint">
                  The word after the opening backticks. Some note apps style a code block by this word. Leave it empty for a plain block.
                </small>
              </div>
            </div>
          )}

          <div className="form-group checkbox-group">
            <label>
              <input
                type="checkbox"
                checked={formData.copy_include_comments === 'true'}
                onChange={(e) => handleChange('copy_include_comments', e.target.checked ? 'true' : 'false')}
              />
              Comments
            </label>
            <small className="settings-hint indent">
              The full comment thread at the end.
            </small>
          </div>
        </section>

        {/* API Keys Section */}
        <section className="settings-section" id="api-keys-section">
          <h3><Key size={20} /> API keys</h3>
          <p className="section-description">
            Add a key for each service you want to use. Each one lists the features it can power.
            <br />
            Recommended: GPT-5 Mini (OpenAI) for narration and read-along, DeepInfra for transcription and TTS.
            <br />
            <a href="https://openrouter.ai/compare/" target="_blank" rel="noopener noreferrer" style={{color: '#4a90e2'}}>Compare model pricing across providers</a>.
          </p>

          <div className="form-group">
            <label>
              <Key size={16} /> DeepInfra API Key
              {isSecretSet('deepinfra_api_key')
                ? <span className="secret-set">(configured)</span>
                : <a href="https://deepinfra.com/dash/api_keys" target="_blank" rel="noopener noreferrer" className="get-key-link">(get a key)</a>}
            </label>
            <div className="input-row">
              <div className="input-with-toggle">
                <input
                  type={showSecrets['deepinfra_api_key'] ? 'text' : 'password'}
                  value={formData.deepinfra_api_key}
                  onChange={(e) => handleChange('deepinfra_api_key', e.target.value)}
                  placeholder={isSecretSet('deepinfra_api_key') ? '••••••••' : 'DeepInfra Key...'}
                />
                <button type="button" onClick={() => toggleShowSecret('deepinfra_api_key')} className="toggle-visibility">
                  {showSecrets['deepinfra_api_key'] ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              {isSecretSet('deepinfra_api_key') && (
                <button type="button" onClick={() => removeApiKey('deepinfra_api_key', 'DeepInfra API key')} className="key-remove-button" title="Remove this key">
                  <Trash2 size={16} />
                </button>
              )}
            </div>
            <small className="settings-hint">Narration, read-along, summaries, TTS, transcription, image descriptions.</small>
          </div>

          <div className="form-group">
            <label>
              <Key size={16} /> OpenAI API Key
              {isSecretSet('openai_api_key')
                ? <span className="secret-set">(configured)</span>
                : <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="get-key-link">(get a key)</a>}
            </label>
            <div className="input-row">
              <div className="input-with-toggle">
                <input
                  type={showSecrets['openai_api_key'] ? 'text' : 'password'}
                  value={formData.openai_api_key}
                  onChange={(e) => handleChange('openai_api_key', e.target.value)}
                  placeholder={isSecretSet('openai_api_key') ? '••••••••' : 'sk-...'}
                />
                <button type="button" onClick={() => toggleShowSecret('openai_api_key')} className="toggle-visibility">
                  {showSecrets['openai_api_key'] ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              {isSecretSet('openai_api_key') && (
                <button type="button" onClick={() => removeApiKey('openai_api_key', 'OpenAI API key')} className="key-remove-button" title="Remove this key">
                  <Trash2 size={16} />
                </button>
              )}
            </div>
            <small className="settings-hint">Narration, read-along, summaries, TTS, transcription, image descriptions.</small>
          </div>

          <div className="form-group">
            <label>
              <Key size={16} /> OpenRouter API Key
              {isSecretSet('openrouter_api_key')
                ? <span className="secret-set">(configured)</span>
                : <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" className="get-key-link">(get a key)</a>}
            </label>
            <div className="input-row">
              <div className="input-with-toggle">
                <input
                  type={showSecrets['openrouter_api_key'] ? 'text' : 'password'}
                  value={formData.openrouter_api_key}
                  onChange={(e) => handleChange('openrouter_api_key', e.target.value)}
                  placeholder={isSecretSet('openrouter_api_key') ? '••••••••' : 'sk-or-...'}
                />
                <button type="button" onClick={() => toggleShowSecret('openrouter_api_key')} className="toggle-visibility">
                  {showSecrets['openrouter_api_key'] ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              {isSecretSet('openrouter_api_key') && (
                <button type="button" onClick={() => removeApiKey('openrouter_api_key', 'OpenRouter API key')} className="key-remove-button" title="Remove this key">
                  <Trash2 size={16} />
                </button>
              )}
            </div>
            <small className="settings-hint">Narration, read-along, summaries, TTS, image descriptions.</small>
          </div>

          <div className="form-group">
            <label>
              <Key size={16} /> Anthropic API Key
              {isSecretSet('anthropic_api_key')
                ? <span className="secret-set">(configured)</span>
                : <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener noreferrer" className="get-key-link">(get a key)</a>}
            </label>
            <div className="input-row">
              <div className="input-with-toggle">
                <input
                  type={showSecrets['anthropic_api_key'] ? 'text' : 'password'}
                  value={formData.anthropic_api_key}
                  onChange={(e) => handleChange('anthropic_api_key', e.target.value)}
                  placeholder={isSecretSet('anthropic_api_key') ? '••••••••' : 'sk-ant-...'}
                />
                <button type="button" onClick={() => toggleShowSecret('anthropic_api_key')} className="toggle-visibility">
                  {showSecrets['anthropic_api_key'] ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              {isSecretSet('anthropic_api_key') && (
                <button type="button" onClick={() => removeApiKey('anthropic_api_key', 'Anthropic API key')} className="key-remove-button" title="Remove this key">
                  <Trash2 size={16} />
                </button>
              )}
            </div>
            <small className="settings-hint">Narration, read-along, summaries.</small>
          </div>

          <div className="form-group">
            <label>
              <Key size={16} /> Gemini API Key
              {isSecretSet('gemini_api_key')
                ? <span className="secret-set">(configured)</span>
                : <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" className="get-key-link">(get a key)</a>}
            </label>
            <div className="input-row">
              <div className="input-with-toggle">
                <input
                  type={showSecrets['gemini_api_key'] ? 'text' : 'password'}
                  value={formData.gemini_api_key}
                  onChange={(e) => handleChange('gemini_api_key', e.target.value)}
                  placeholder={isSecretSet('gemini_api_key') ? '••••••••' : 'Gemini API Key...'}
                />
                <button type="button" onClick={() => toggleShowSecret('gemini_api_key')} className="toggle-visibility">
                  {showSecrets['gemini_api_key'] ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              {isSecretSet('gemini_api_key') && (
                <button type="button" onClick={() => removeApiKey('gemini_api_key', 'Gemini API key')} className="key-remove-button" title="Remove this key">
                  <Trash2 size={16} />
                </button>
              )}
            </div>
            <small className="settings-hint">Narration, read-along, summaries, image descriptions.</small>
          </div>
        </section>

        {/* Models Section: which provider/model handles each AI job. */}
        <section className="settings-section">
          <h3><Mic size={20} /> Models</h3>
          <p className="section-description">
            Which AI model handles each feature. Leave a model blank to use our recommended default.
          </p>

          {renderChatJob('narration', 'Narration', 'Prepares articles in the background for audio narration.', true)}
          {renderChatJob('alignment', 'Read-along alignment', 'Syncs the script to audio timestamps for the read-along view.')}
          {renderChatJob('summary', 'Summaries', 'Writes the tweet-thread summaries.')}

          <div className="form-group ai-job">
            <label>Transcription</label>
            <small className="settings-hint" style={{ marginBottom: '0.5rem' }}>Turns podcast audio into text (Whisper).</small>
            <div className="ai-job-fields">
              <div className="ai-field">
                <span className="ai-field-label">Provider</span>
                <select value={formData.transcription_provider} onChange={(e) => handleChange('transcription_provider', e.target.value)}>
                  {TRANSCRIPTION_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </div>
              {formData.transcription_provider === 'deepinfra' && (
                <div className="ai-field">
                  <span className="ai-field-label">Preset</span>
                  <select
                    value={DEEPINFRA_WHISPER_PRESETS.some(p => p.id === formData.transcription_model) ? formData.transcription_model : ''}
                    onChange={(e) => { if (e.target.value) handleChange('transcription_model', e.target.value); }}
                  >
                    <option value="">Custom…</option>
                    {DEEPINFRA_WHISPER_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                </div>
              )}
              <div className="ai-field">
                <span className="ai-field-label">Model</span>
                <input
                  type="text"
                  value={formData.transcription_model}
                  onChange={(e) => handleChange('transcription_model', e.target.value)}
                  placeholder={TRANSCRIPTION_PROVIDERS.find(p => p.id === formData.transcription_provider)?.hint || 'model name'}
                />
              </div>
            </div>
          </div>

          <div className="form-group ai-job">
            <label>TTS voices{ttsVoices.length > 0 ? ` (${ttsVoices.length} selected)` : ''}</label>
            <small className="settings-hint">
              Pick one voice for a consistent sound, or several to rotate between (each new audio picks one at random).
            </small>
            <div className="ai-field" style={{ marginTop: '0.5rem' }}>
              <span className="ai-field-label">Kokoro voices via</span>
              <select value={formData.kokoro_tts_provider} onChange={(e) => handleChange('kokoro_tts_provider', e.target.value)}>
                <option value="deepinfra">DeepInfra</option>
                <option value="openrouter">OpenRouter</option>
              </select>
            </div>
            {availableVoiceGroups.length === 0 ? (
              <p className="no-content" style={{ fontSize: '0.9rem', marginTop: '0.5rem' }}>
                Add an OpenAI, OpenRouter, or DeepInfra key to choose voices.
              </p>
            ) : (
              <div style={{ marginTop: '0.5rem' }}>
                {availableVoiceGroups.map(group => (
                  <div key={group.model} className="voice-group">
                    <div className="voice-group-title">{group.group}</div>
                    {group.note && <div className="voice-group-note">{group.note}</div>}
                    <div className="voice-grid">
                      {group.voices.map(v => (
                        <label key={v.id} className={`voice-chip ${isVoiceSelected(group.model, v.id) ? 'selected' : ''}`}>
                          <input
                            type="checkbox"
                            checked={isVoiceSelected(group.model, v.id)}
                            onChange={() => toggleVoice(group.model, v.id)}
                          />
                          {v.label}
                          <button
                            type="button"
                            className="voice-preview-btn"
                            title="Preview voice"
                            onClick={(e) => playVoicePreview(group.model, v.id, e)}
                          >
                            {playingPreview === `${group.model}:${v.id}` ? <Square size={12} /> : <Volume2 size={13} />}
                          </button>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="form-group ai-job">
            <label>Image descriptions</label>
            <small className="settings-hint">Describes article images so they can be read aloud.</small>
            <label className="checkbox-inline" style={{ marginTop: '0.5rem', marginBottom: formData.image_alt_text_enabled === 'true' ? '0.5rem' : 0 }}>
              <input
                type="checkbox"
                checked={formData.image_alt_text_enabled === 'true'}
                onChange={(e) => handleChange('image_alt_text_enabled', e.target.checked ? 'true' : 'false')}
              />
              Enable image descriptions
            </label>
            {formData.image_alt_text_enabled === 'true' && (
              <div className="ai-job-fields">
                <div className="ai-field">
                  <span className="ai-field-label">Provider</span>
                  <select
                    value={formData.image_alt_text_provider}
                    onChange={(e) => {
                      const p = e.target.value;
                      handleChange('image_alt_text_provider', p);
                      // If the model box holds another provider's default, clear it so the new
                      // provider's own default applies (blank = default, never pinned).
                      const m = formData.image_alt_text_model;
                      if (m && Object.values(IMAGE_MODEL_DEFAULTS).includes(m)) {
                        handleChange('image_alt_text_model', '');
                      }
                    }}
                  >
                    <option value="deepinfra">DeepInfra</option>
                    <option value="gemini">Google Gemini</option>
                    <option value="openai">OpenAI</option>
                    <option value="openrouter">OpenRouter</option>
                  </select>
                </div>
                <div className="ai-field">
                  <span className="ai-field-label">Model</span>
                  <input
                    type="text"
                    value={formData.image_alt_text_model}
                    onChange={(e) => handleChange('image_alt_text_model', e.target.value)}
                    placeholder={'default = ' + (IMAGE_MODEL_DEFAULTS[formData.image_alt_text_provider] || 'gemini-3-flash-preview')}
                  />
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Custom prompts (advanced): registry-driven editor for every LLM prompt, grouped by category. */}
        <section className="settings-section">
          <h3>Custom prompts (advanced)</h3>
          <p className="section-description">
            Edit any LLM prompt the app uses (summaries, narration, read-along, image descriptions).
            Leave a box at its default to keep the built-in prompt. Placeholders like <code>{'{maxWords}'}</code>{' '}
            are filled in automatically at generation time. A custom prompt is used as-is until you reset it.
          </p>

          <button
            type="button"
            className="settings-collapse-toggle"
            onClick={() => setShowCustomPrompts(v => !v)}
            aria-expanded={showCustomPrompts}
          >
            {showCustomPrompts ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <span>Show prompt editor</span>
          </button>

          {showCustomPrompts && (
            <div className="settings-collapse-body">
              {prompts.length === 0 && (
                <small className="settings-hint">Could not load the prompt list. Try reloading the page.</small>
              )}
              {[...new Set(prompts.map(p => p.category))].map(cat => {
                const catPrompts = prompts.filter(p => p.category === cat);
                const open = openPromptCats[cat] ?? false;
                const customCount = catPrompts.filter(p => {
                  const v = (promptValues[promptKey(p.id)] || '').trim();
                  return v && v !== (p.default || '').trim();
                }).length;
                return (
                  <div key={cat} style={{ marginBottom: '0.5rem' }}>
                    <button
                      type="button"
                      className="settings-collapse-toggle"
                      onClick={() => setOpenPromptCats(s => ({ ...s, [cat]: !open }))}
                      aria-expanded={open}
                    >
                      {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      <span>{cat}{customCount > 0 ? ` (${customCount} customized)` : ''}</span>
                    </button>

                    {open && (
                      <div className="settings-collapse-body">
                        {catPrompts.map(p => {
                          const key = promptKey(p.id);
                          const value = promptValues[key] ?? '';
                          const isDefault = value.trim() === (p.default || '').trim();
                          return (
                            <div className="form-group" key={p.id}>
                              <label>
                                {p.label}
                                {!isDefault && (
                                  <>
                                    {' '}
                                    <button
                                      type="button"
                                      className="settings-badge-custom settings-reset-link"
                                      onClick={() => { setPromptValues(s => ({ ...s, [key]: p.default })); setSaved(false); }}
                                      title="Reset this prompt to its built-in default"
                                    >
                                      (customized, reset to default)
                                    </button>
                                  </>
                                )}
                              </label>
                              <small className="settings-hint">{p.description}</small>
                              {p.vars.length > 0 && (
                                <small className="settings-hint">
                                  {p.vars.map((v, i) => (
                                    <span key={v.token}>
                                      {i > 0 && ' • '}
                                      <code>{`{${v.token}}`}</code> = {v.desc}
                                    </span>
                                  ))}
                                </small>
                              )}
                              <textarea
                                value={value}
                                onChange={(e) => { setPromptValues(s => ({ ...s, [key]: e.target.value })); setSaved(false); }}
                                rows={10}
                                spellCheck={false}
                                style={{ width: '100%', marginTop: '0.5rem', fontFamily: 'monospace', fontSize: '0.8rem', resize: 'vertical' }}
                              />
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Wallabag Settings */}
        <section className="settings-section">
          <h3>
            <Globe size={20} />
            Wallabag sync
          </h3>

          <div style={{
            padding: '0.75rem',
            background: '#1e3a5f',
            borderRadius: '0.5rem',
            fontSize: '0.875rem',
            lineHeight: '1.5',
            marginBottom: '1rem',
            border: '1px solid #2563eb',
            color: '#fff'
          }}>
            <button
              type="button"
              className="settings-collapse-toggle"
              style={{ color: '#fff', padding: 0 }}
              onClick={() => setShowWallabagHelp(v => !v)}
              aria-expanded={showWallabagHelp}
            >
              {showWallabagHelp ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <strong>How to connect</strong>
            </button>
            {showWallabagHelp && (<>
            <ol style={{ marginTop: '0.5rem', paddingLeft: '1.25rem' }}>
              <li>Log into your Wallabag instance</li>
              <li>Go to <strong>Settings → API clients management</strong></li>
              <li>Create a new client (name: "Wallacast")</li>
              <li>Copy the <strong>Client ID</strong> and <strong>Client Secret</strong></li>
              <li>Enter those credentials below along with your Wallabag URL, username, and password</li>
            </ol>
            <p style={{ marginTop: '0.5rem', paddingLeft: '0rem' }}>
            Note: entries tagged nosync in Wallabag are never pulled; a local copy is kept but gets a nosync chip and is never pushed. Tags sync both ways (Wallabag-side tag edits are picked up by a cheap whole-library check on every sync, and merged so a tag added on either side survives). A sync never deletes local items or overwrites content Wallacast fetched itself. A full refresh (see button below) might be required to sync older items.
            </p>
            </>)}
          </div>

          <div className="form-group checkbox-group">
            <label>
              <input
                type="checkbox"
                checked={formData.wallabag_sync_enabled === 'true'}
                onChange={(e) => handleChange('wallabag_sync_enabled', e.target.checked ? 'true' : 'false')}
              />
              Enable Wallabag sync
            </label>
          </div>

          {formData.wallabag_sync_enabled === 'true' && (
            <>
              <div className="form-group">
                <label>Wallabag URL</label>
                <input
                  type="url"
                  value={formData.wallabag_url}
                  onChange={(e) => handleChange('wallabag_url', e.target.value)}
                  placeholder="https://wallabag.example.com"
                />
              </div>

              <div className="form-group">
                <label>Client ID</label>
                <input
                  type="text"
                  value={formData.wallabag_client_id}
                  onChange={(e) => handleChange('wallabag_client_id', e.target.value)}
                  placeholder="Your Wallabag client ID"
                />
              </div>

              <div className="form-group">
                <label>
                  Client Secret
                  {isSecretSet('wallabag_client_secret') && (
                    <span className="secret-set">(configured)</span>
                  )}
                </label>
                <div className="input-with-toggle">
                  <input
                    type={showSecrets['wallabag_client_secret'] ? 'text' : 'password'}
                    value={formData.wallabag_client_secret}
                    onChange={(e) => handleChange('wallabag_client_secret', e.target.value)}
                    placeholder={isSecretSet('wallabag_client_secret') ? '••••••••' : 'Your client secret'}
                  />
                  <button type="button" onClick={() => toggleShowSecret('wallabag_client_secret')} className="toggle-visibility">
                    {showSecrets['wallabag_client_secret'] ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              <div className="form-group">
                <label>Wallabag Username</label>
                <input
                  type="text"
                  value={formData.wallabag_username}
                  onChange={(e) => handleChange('wallabag_username', e.target.value)}
                  placeholder="Your Wallabag username"
                />
              </div>

              <div className="form-group">
                <label>
                  Wallabag Password
                  {isSecretSet('wallabag_password') && (
                    <span className="secret-set">(configured)</span>
                  )}
                </label>
                <div className="input-with-toggle">
                  <input
                    type={showSecrets['wallabag_password'] ? 'text' : 'password'}
                    value={formData.wallabag_password}
                    onChange={(e) => handleChange('wallabag_password', e.target.value)}
                    placeholder={isSecretSet('wallabag_password') ? '••••••••' : 'Your Wallabag password'}
                  />
                  <button type="button" onClick={() => toggleShowSecret('wallabag_password')} className="toggle-visibility">
                    {showSecrets['wallabag_password'] ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              {/* Connection Test */}
              <div className="form-group" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.5rem', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={handleTestConnection}
                  disabled={testingConnection || !formData.wallabag_url || !formData.wallabag_client_id}
                  className="test-connection-button"
                >
                  <Globe size={16} />
                  {testingConnection ? 'Testing...' : 'Test Connection'}
                </button>

                <button
                  type="button"
                  onClick={handleFullRefresh}
                  disabled={syncing}
                  className="test-connection-button"
                  title="Fetch ALL items from Wallabag (ignores last sync timestamp)"
                >
                  <RefreshCw size={16} />
                  Full Refresh
                </button>

                <button
                  type="button"
                  onClick={handleCleanup}
                  disabled={syncing}
                  className="test-connection-button danger"
                  title="Delete recently synced items (last 2 hours)"
                >
                  <Trash2 size={16} />
                  Cleanup
                </button>

                {connectionStatus === 'success' && (
                  <span style={{ color: 'green' }}>✓ Connected</span>
                )}
                {connectionStatus === 'failed' && (
                  <span style={{ color: 'red' }}>✗ Failed</span>
                )}
              </div>

              {/* Connection Error */}
              {connectionError && (
                <div className="form-group" style={{
                  padding: '0.5rem',
                  background: '#fee',
                  borderRadius: '4px',
                  color: '#c33',
                  fontSize: '0.9rem'
                }}>
                  {connectionError}
                </div>
              )}

              {/* Status Info */}
              {wallabagStatus && (
                <div className="form-group" style={{
                  padding: '0.5rem',
                  background: 'var(--bg-app)',
                  borderRadius: '4px',
                  fontSize: '0.9rem',
                  color: 'var(--t3)'
                }}>
                  <div>
                    <strong>Status:</strong> {wallabagStatus.enabled ? 'Enabled' : 'Disabled'}
                  </div>
                  {wallabagStatus.lastSync && (
                    <div>
                      <strong>Last Sync:</strong> {new Date(wallabagStatus.lastSync).toLocaleString('en-GB')}
                    </div>
                  )}
                  {wallabagStatus.pendingChanges > 0 && (
                    <div>
                      <strong>Pending Changes:</strong> {wallabagStatus.pendingChanges}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </section>

        </fieldset>

      </div>
    </div>
  );
}
