import { useState, useEffect } from 'react';
import { ArrowLeft, Save, Eye, EyeOff, Key, Globe, Check, AlertCircle, Mic, FileText, Plus, Trash2 } from 'lucide-react';
import { userSettingsAPI, wallabagAPI } from '../api';
import { useAuthStore } from '../store/authStore';

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
    const tiers: SummaryTier[] = arr.map((t: any) => ({
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

interface AIProvider {
  name: string;
  models?: {
    chat?: string[];
    tts?: string[];
  };
  voices?: string[];
  requiredSettings: string[];
  description: string;
  comingSoon?: boolean;
}

export function SettingsPage({ onBack }: SettingsPageProps) {
  const { user, logout } = useAuthStore();
  const [settings, setSettings] = useState<Record<string, string | null>>({});
  const [providers, setProviders] = useState<Record<string, AIProvider>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});

  // Summary length tiers (editable, sorted list). Infinity tier is always last.
  const [summaryTiers, setSummaryTiers] = useState<SummaryTier[]>(DEFAULT_SUMMARY_TIERS);

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
    ai_provider: 'openai',
    openai_api_key: '',
    openai_model: 'gpt-5-nano',
    openai_tts_model: 'gpt-4o-mini-tts',
    openai_tts_voice: 'coral',

    // DeepInfra Settings
    deepinfra_api_key: '',

    // Narration LLM
    narration_llm: 'auto',

    // Gemini Settings (for image alt-text)
    gemini_api_key: '',
    image_alt_text_enabled: 'true',

    auto_transcribe_podcasts: 'true',
    auto_generate_audio_for_articles: 'false',
    // Summaries
    auto_generate_summary: 'false',
    summarize_comments: 'true',
    narrate_ea_forum_comments: 'true',
    narrate_substack_comments: 'true',
    max_narrated_comments: '50',
    manual_queue_always_autoplay: 'true',
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
      const [settingsRes, providersRes] = await Promise.all([
        userSettingsAPI.getAll(),
        userSettingsAPI.getAIProviders(),
      ]);
      setSettings(settingsRes.data.settings);
      setProviders(providersRes.data.providers);

      const loaded = settingsRes.data.settings;
      console.log('Loaded settings from server:', loaded);

      setFormData(prev => ({
        ...prev,
        ai_provider: loaded.ai_provider || 'openai',
        openai_api_key: loaded.openai_api_key === '••••••••' ? '' : (loaded.openai_api_key || ''),
        openai_model: loaded.openai_model || 'gpt-5-nano',
        openai_tts_model: loaded.openai_tts_model || 'gpt-4o-mini-tts',
        openai_tts_voice: loaded.openai_tts_voice || 'coral',

        deepinfra_api_key: loaded.deepinfra_api_key === '••••••••' ? '' : (loaded.deepinfra_api_key || ''),

        narration_llm: loaded.narration_llm || 'auto',

        gemini_api_key: loaded.gemini_api_key === '••••••••' ? '' : (loaded.gemini_api_key || ''),
        image_alt_text_enabled: loaded.image_alt_text_enabled !== undefined && loaded.image_alt_text_enabled !== null ? loaded.image_alt_text_enabled : 'true',

        auto_transcribe_podcasts: loaded.auto_transcribe_podcasts !== undefined && loaded.auto_transcribe_podcasts !== null ? loaded.auto_transcribe_podcasts : 'true',
        auto_generate_audio_for_articles: loaded.auto_generate_audio_for_articles !== undefined && loaded.auto_generate_audio_for_articles !== null ? loaded.auto_generate_audio_for_articles : 'false',
        auto_generate_summary: loaded.auto_generate_summary !== undefined && loaded.auto_generate_summary !== null ? loaded.auto_generate_summary : 'false',
        summarize_comments: loaded.summarize_comments !== undefined && loaded.summarize_comments !== null ? loaded.summarize_comments : 'true',
        narrate_ea_forum_comments: loaded.narrate_ea_forum_comments !== undefined && loaded.narrate_ea_forum_comments !== null ? loaded.narrate_ea_forum_comments : 'true',
        narrate_substack_comments: loaded.narrate_substack_comments !== undefined && loaded.narrate_substack_comments !== null ? loaded.narrate_substack_comments : 'true',
        max_narrated_comments: loaded.max_narrated_comments || '50',
        manual_queue_always_autoplay: loaded.manual_queue_always_autoplay !== undefined && loaded.manual_queue_always_autoplay !== null ? loaded.manual_queue_always_autoplay : 'true',
        wallabag_url: loaded.wallabag_url || '',
        wallabag_client_id: loaded.wallabag_client_id || '',
        wallabag_client_secret: loaded.wallabag_client_secret === '••••••••' ? '' : (loaded.wallabag_client_secret || ''),
        wallabag_username: loaded.wallabag_username || '',
        wallabag_password: loaded.wallabag_password === '••••••••' ? '' : (loaded.wallabag_password || ''),
        wallabag_sync_enabled: loaded.wallabag_sync_enabled !== undefined && loaded.wallabag_sync_enabled !== null ? loaded.wallabag_sync_enabled : 'false',
      }));

      setSummaryTiers(parseTiers(loaded.summary_tiers));
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

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      
      const toSave: Record<string, string> = {};
      for (const [key, value] of Object.entries(formData)) {
        const isBooleanSetting = key === 'auto_transcribe_podcasts' ||
                                 key === 'auto_generate_audio_for_articles' ||
                                 key === 'auto_generate_summary' ||
                                 key === 'summarize_comments' ||
                                 key === 'wallabag_sync_enabled' ||
                                 key === 'image_alt_text_enabled' ||
                                 key === 'narrate_ea_forum_comments' ||
                                 key === 'narrate_substack_comments' ||
                                 key === 'manual_queue_always_autoplay';

        if (isBooleanSetting) {
          toSave[key] = value;
        } else if (value && value !== '' && value !== '••••••••') {
          toSave[key] = value;
        }
      }

      // Summary tiers are managed in their own state — serialize (Infinity -> null) on save.
      toSave.summary_tiers = serializeTiers(summaryTiers);

      console.log('Saving settings:', toSave);
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

  const currentProvider = providers[formData.ai_provider];
  const isDeepInfraTTS = formData.openai_tts_model?.includes('hexgrad') || formData.openai_tts_model?.includes('Kokoro');

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
          disabled={saving}
        >
          {saved ? <Check size={18} /> : <Save size={18} />}
          <span>{saving ? 'Saving...' : saved ? 'Saved' : 'Save'}</span>
        </button>
      </header>

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
        </section>

        {/* API Keys Section */}
        <section className="settings-section">
          <h3><Key size={20} /> API Keys</h3>
          <p className="section-description" style={{fontSize: '0.9rem', color: '#666', marginBottom: '1rem'}}>
            You only need keys for the services you want. With just a DeepInfra key you can do everything (narration prep, TTS, and transcription).
          </p>

          <div className="form-group">
            <label>
              <Key size={16} /> DeepInfra API Key
              {isSecretSet('deepinfra_api_key') && <span className="secret-set">(configured)</span>}
            </label>
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
            <small style={{display: 'block', marginTop: '0.25rem', color: '#888', fontSize: '0.85rem'}}>
              Powers TTS (Kokoro), transcription (Whisper), and narration prep (DeepSeek). Cheapest option.
            </small>
          </div>

          <div className="form-group">
            <label>
              <Key size={16} /> OpenAI API Key
              {isSecretSet('openai_api_key') && <span className="secret-set">(configured)</span>}
            </label>
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
            <small style={{display: 'block', marginTop: '0.25rem', color: '#888', fontSize: '0.85rem'}}>
              Optional. For OpenAI TTS voices and GPT narration prep. Not needed if using DeepInfra for everything.
            </small>
          </div>

          <div className="form-group">
            <label>
              <Key size={16} /> Gemini API Key
              {isSecretSet('gemini_api_key') && <span className="secret-set">(configured)</span>}
            </label>
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
            <small style={{display: 'block', marginTop: '0.25rem', color: '#888', fontSize: '0.85rem'}}>
              Optional. Describes images in articles for audio narration. Paid tier required. Get key at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" style={{color: '#4a90e2'}}>Google AI Studio</a>
            </small>
          </div>
        </section>

        {/* Audio Generation Section */}
        <section className="settings-section">
           <h3><Mic size={20} /> Audio Generation</h3>
           <p className="section-description" style={{fontSize: '0.9rem', color: '#666', marginBottom: '1rem'}}>
             How articles get converted to audio: Narration LLM scripts the text, then TTS speaks it.
           </p>

           <div className="form-group">
                <label>Narration LLM</label>
                <select value={formData.narration_llm} onChange={(e) => handleChange('narration_llm', e.target.value)}>
                  <option value="auto">Auto (prefers DeepSeek if DeepInfra key is set)</option>
                  <option value="deepseek">DeepSeek V3.2 (via DeepInfra)</option>
                  <option value="openai">OpenAI GPT-5-Nano (fast, cheap)</option>
                  <option value="openai-mini">OpenAI GPT-5-Mini (smarter, slower)</option>
                </select>
                <small style={{display: 'block', marginTop: '0.25rem', color: '#888', fontSize: '0.85rem'}}>
                  Prepares article text for speech.
                </small>
            </div>

            <div className="form-group">
                <label>TTS Model</label>
                <select value={formData.openai_tts_model} onChange={(e) => handleChange('openai_tts_model', e.target.value)}>
                   {currentProvider?.models?.tts?.map(model => (
                     <option key={model} value={model}>{model}</option>
                   ))}
                   {!currentProvider?.models?.tts?.includes('hexgrad/Kokoro-82M') && (
                      <option value="hexgrad/Kokoro-82M">Kokoro 82M (DeepInfra) - 25x Cheaper</option>
                   )}
                </select>
            </div>

            <div className="form-group">
                <label>TTS Voice</label>
                {isDeepInfraTTS ? (
                    <select value={formData.openai_tts_voice} onChange={(e) => handleChange('openai_tts_voice', e.target.value)}>
                        <option value="af_heart">Heart (Female)</option>
                        <option value="af_bella">Bella (Female)</option>
                        <option value="af_nicole">Nicole (Female)</option>
                        <option value="am_adam">Adam (Male)</option>
                        <option value="am_michael">Michael (Male)</option>
                        <option value="am_puck">Puck (Male) - Recommended</option>
                    </select>
                ) : (
                    <select value={formData.openai_tts_voice} onChange={(e) => handleChange('openai_tts_voice', e.target.value)}>
                        {currentProvider?.voices?.map(voice => (
                             <option key={voice} value={voice}>{voice}</option>
                        ))}
                    </select>
                )}
            </div>

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
                 <small style={{display: 'block', marginTop: '0.25rem', color: '#888', fontSize: '0.85rem'}}>
                   Includes replies. You can still generate these articles manually.
                 </small>
               </div>
             )}

             <div className="form-group checkbox-group">
                <label>
                  <input
                    type="checkbox"
                    checked={formData.image_alt_text_enabled === 'true'}
                    onChange={(e) => handleChange('image_alt_text_enabled', e.target.checked ? 'true' : 'false')}
                  />
                  Generate image descriptions for audio
                </label>
                <small style={{display: 'block', marginTop: '0.25rem', color: '#888', fontSize: '0.85rem', marginLeft: '1.5rem'}}>
                  Requires Gemini API key.
                </small>
             </div>
        </section>

        {/* Summaries Section */}
        <section className="settings-section">
          <h3><FileText size={20} /> Summaries</h3>
          <p className="section-description" style={{fontSize: '0.9rem', color: '#666', marginBottom: '1rem'}}>
            Short "Twitter thread" summaries (each paragraph ≤ 280 characters), written by the same
            narration LLM. Generated separately from audio — both can run at the same time.
          </p>

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
                checked={formData.summarize_comments === 'true'}
                onChange={(e) => handleChange('summarize_comments', e.target.checked ? 'true' : 'false')}
              />
              Also summarize comments
            </label>
            <small style={{display: 'block', marginTop: '0.25rem', color: '#888', fontSize: '0.85rem', marginLeft: '1.5rem'}}>
              Adds a separate comment-discussion summary below the article summary (when the item has comments).
            </small>
          </div>

          <div className="form-group">
            <label>Summary length tiers</label>
            <small style={{display: 'block', marginTop: '0.25rem', marginBottom: '0.5rem', color: '#888', fontSize: '0.85rem'}}>
              Longer content gets more paragraphs. The character count is measured automatically; the matching
              tier sets the maximum number of paragraphs ("tweets").
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
            <small style={{display: 'block', marginTop: '0.25rem', color: '#888', fontSize: '0.85rem', marginLeft: '1.5rem'}}>
              When on (default), items you explicitly added to the queue auto-advance regardless of the autoplay toggle.
              Turn off if you only want anything to auto-advance when the player's autoplay toggle is on.
            </small>
          </div>
        </section>

        {/* Wallabag Settings (Restored) */}
        <section className="settings-section">
          <h3>
            <Globe size={20} />
            Wallabag Sync (optional)
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
            <strong>How to connect:</strong>
            <ol style={{ marginTop: '0.5rem', paddingLeft: '1.25rem' }}>
              <li>Log into your Wallabag instance</li>
              <li>Go to <strong>Settings → API clients management</strong></li>
              <li>Create a new client (name: "Wallacast")</li>
              <li>Copy the <strong>Client ID</strong> and <strong>Client Secret</strong></li>
              <li>Enter those credentials below along with your Wallabag URL, username, and password</li>
            </ol>
            <ol style={{ marginTop: '0.5rem', paddingLeft: '0rem' }}>
            Note: The wallabag sync ignores articles with a nosync tag. A full refresh (see button below) might be required to sync older items.
            </ol>
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
                  {testingConnection ? 'Testing...' : 'Test Connection'}
                </button>

                <button
                  type="button"
                  onClick={handleFullRefresh}
                  disabled={syncing}
                  className="test-connection-button"
                  style={{ background: '#0891b2' }}
                  title="Fetch ALL items from Wallabag (ignores last sync timestamp)"
                >
                  🔄 Full Refresh
                </button>

                <button
                  type="button"
                  onClick={handleCleanup}
                  disabled={syncing}
                  className="test-connection-button"
                  style={{ background: '#dc2626' }}
                  title="Delete recently synced items (last 2 hours)"
                >
                  🗑️ Cleanup
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
                  background: '#f0f0f0',
                  borderRadius: '4px',
                  fontSize: '0.9rem',
                  color: '#666'
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
      </div>
    </div>
  );
}
