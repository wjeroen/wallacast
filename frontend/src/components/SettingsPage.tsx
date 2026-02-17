import { useState, useEffect } from 'react';
import { ArrowLeft, Save, Eye, EyeOff, Key, Globe, Check, AlertCircle, Mic } from 'lucide-react';
import { userSettingsAPI, wallabagAPI } from '../api';
import { useAuthStore } from '../store/authStore';

interface SettingsPageProps {
  onBack: () => void;
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
        wallabag_url: loaded.wallabag_url || '',
        wallabag_client_id: loaded.wallabag_client_id || '',
        wallabag_client_secret: loaded.wallabag_client_secret === '••••••••' ? '' : (loaded.wallabag_client_secret || ''),
        wallabag_username: loaded.wallabag_username || '',
        wallabag_password: loaded.wallabag_password === '••••••••' ? '' : (loaded.wallabag_password || ''),
        wallabag_sync_enabled: loaded.wallabag_sync_enabled !== undefined && loaded.wallabag_sync_enabled !== null ? loaded.wallabag_sync_enabled : 'false',
      }));
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

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      
      const toSave: Record<string, string> = {};
      for (const [key, value] of Object.entries(formData)) {
        const isBooleanSetting = key === 'auto_transcribe_podcasts' ||
                                 key === 'auto_generate_audio_for_articles' ||
                                 key === 'wallabag_sync_enabled' ||
                                 key === 'image_alt_text_enabled';

        if (isBooleanSetting) {
          toSave[key] = value;
        } else if (value && value !== '' && value !== '••••••••') {
          toSave[key] = value;
        }
      }

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
                  <option value="openai">OpenAI GPT-5-nano</option>
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
