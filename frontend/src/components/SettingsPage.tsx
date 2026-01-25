import { useState, useEffect } from 'react';
import { ArrowLeft, Save, Eye, EyeOff, Key, Bot, Globe, Check, AlertCircle, Mic } from 'lucide-react';
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
    openai_model: 'gpt-4o-mini',
    openai_tts_model: 'gpt-4o-mini-tts',
    openai_tts_voice: 'coral',
    
    // NEW: DeepInfra Settings
    deepinfra_api_key: '',
    
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
        openai_model: loaded.openai_model || 'gpt-4o-mini',
        openai_tts_model: loaded.openai_tts_model || 'gpt-4o-mini-tts',
        openai_tts_voice: loaded.openai_tts_voice || 'coral',
        
        // Load DeepInfra key
        deepinfra_api_key: loaded.deepinfra_api_key === '••••••••' ? '' : (loaded.deepinfra_api_key || ''),
        
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
                                 key === 'wallabag_sync_enabled';

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

  // ... [Keep connection/cleanup handlers] ...
  const handleTestConnection = async () => { /* ... */ };
  const handleCleanup = async () => { /* ... */ };
  const handleFullRefresh = async () => { /* ... */ };

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
  
  // Custom Logic: Are we using a DeepInfra model?
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

        {/* AI Provider Settings */}
        <section className="settings-section">
          <h3><Bot size={20} /> AI Provider</h3>
          <div className="form-group">
            <label>Provider</label>
            <select
              value={formData.ai_provider}
              onChange={(e) => handleChange('ai_provider', e.target.value)}
            >
              <option value="openai">OpenAI (Recommended)</option>
              {/* We can add pure DeepInfra here later if you want Chat from them too */}
            </select>
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
          </div>
           
           <div className="form-group">
                <label>Chat Model</label>
                <select value={formData.openai_model} onChange={(e) => handleChange('openai_model', e.target.value)}>
                   {currentProvider?.models?.chat?.map(model => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
            </div>
        </section>

        {/* AUDIO SERVICES (New Section) */}
        <section className="settings-section">
           <h3><Mic size={20} /> Audio Services</h3>
           <p className="section-description" style={{fontSize: '0.9rem', color: '#666', marginBottom: '1rem'}}>
             Configure Text-to-Speech and Transcription engines.
           </p>

           <div className="form-group">
                <label>
                  <Key size={16} /> DeepInfra API Key (Cheaper TTS & Whisper)
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
            </div>

            <div className="form-group">
                <label>TTS Model</label>
                <select value={formData.openai_tts_model} onChange={(e) => handleChange('openai_tts_model', e.target.value)}>
                   {/* We will need backend update to populate these, but we can hardcode fallback for now */}
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
                        <option value="af_heart">Heart (Female) - Recommended</option>
                        <option value="af_bella">Bella (Female)</option>
                        <option value="af_nicole">Nicole (Female)</option>
                        <option value="am_adam">Adam (Male)</option>
                        <option value="am_michael">Michael (Male)</option>
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
                  Auto-transcribe podcasts (Uses DeepInfra if key set)
                </label>
             </div>
        </section>

        {/* Wallabag Settings (Keep as is) */}
        <section className="settings-section">
          <h3><Globe size={20} /> Wallabag Sync</h3>
          {/* ... [Rest of Wallabag Code] ... */}
          {/* Include the rest of the file content here essentially unchanged */}
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
          {/* ... etc ... */}
        </section>
      </div>
    </div>
  );
}
