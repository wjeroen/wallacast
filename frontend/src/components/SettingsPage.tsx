import { useState, useEffect } from 'react';
import { ArrowLeft, Save, Eye, EyeOff, Key, Bot, Globe, Check, AlertCircle } from 'lucide-react';
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
  const [syncResult, setSyncResult] = useState<{
    pulled: number;
    errors: string[];
  } | null>(null);

  // Form state
  const [formData, setFormData] = useState({
    // AI Settings
    ai_provider: 'openai',
    openai_api_key: '',
    openai_model: 'gpt-4o-mini',
    openai_tts_model: 'gpt-4o-mini-tts',
    openai_tts_voice: 'coral',
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
      // Ignore errors, status just won't show
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

      // Update form with loaded settings
      const loaded = settingsRes.data.settings;
      setFormData(prev => ({
        ...prev,
        ai_provider: loaded.ai_provider || 'openai',
        openai_api_key: loaded.openai_api_key === '••••••••' ? '' : (loaded.openai_api_key || ''),
        openai_model: loaded.openai_model || 'gpt-4o-mini',
        openai_tts_model: loaded.openai_tts_model || 'gpt-4o-mini-tts',
        openai_tts_voice: loaded.openai_tts_voice || 'coral',
        wallabag_url: loaded.wallabag_url || '',
        wallabag_client_id: loaded.wallabag_client_id || '',
        wallabag_client_secret: loaded.wallabag_client_secret === '••••••••' ? '' : (loaded.wallabag_client_secret || ''),
        wallabag_username: loaded.wallabag_username || '',
        wallabag_password: loaded.wallabag_password === '••••••••' ? '' : (loaded.wallabag_password || ''),
        wallabag_sync_enabled: loaded.wallabag_sync_enabled || 'false',
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

      // Only send non-empty values, and don't send masked values
      const toSave: Record<string, string> = {};
      for (const [key, value] of Object.entries(formData)) {
        if (value && value !== '••••••••') {
          toSave[key] = value;
        }
      }

      await userSettingsAPI.setBulk(toSave);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
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
        // Refresh status after successful test
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

  const handlePullFromWallabag = async () => {
    setSyncing(true);
    setSyncResult(null);
    setConnectionError(null);

    try {
      const response = await wallabagAPI.pull();
      setSyncResult(response.data);

      // Refresh status after sync
      await loadWallabagStatus();

      if (response.data.errors.length > 0) {
        console.warn('Pull completed with errors:', response.data.errors);
      }
    } catch (err) {
      setConnectionError('Pull sync failed. Check console for details.');
      console.error('Pull sync error:', err);
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return (
      <div className="settings-page">
        <header className="settings-header">
          <button onClick={onBack} className="back-button">
            <ArrowLeft size={24} />
          </button>
          <h2>Settings</h2>
        </header>
        <div className="settings-loading">Loading settings...</div>
      </div>
    );
  }

  const currentProvider = providers[formData.ai_provider];

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
          <h3>
            <Bot size={20} />
            AI Provider
          </h3>

          <div className="form-group">
            <label>Provider</label>
            <select
              value={formData.ai_provider}
              onChange={(e) => handleChange('ai_provider', e.target.value)}
            >
              {Object.entries(providers).map(([key, provider]) => (
                <option key={key} value={key} disabled={provider.comingSoon}>
                  {provider.name} {provider.comingSoon ? '(Coming Soon)' : ''}
                </option>
              ))}
            </select>
          </div>

          {currentProvider && (
            <p className="provider-description">{currentProvider.description}</p>
          )}

          {formData.ai_provider === 'openai' && (
            <>
              <div className="form-group">
                <label>
                  <Key size={16} />
                  API Key
                  {isSecretSet('openai_api_key') && (
                    <span className="secret-set">(configured)</span>
                  )}
                </label>
                <div className="input-with-toggle">
                  <input
                    type={showSecrets['openai_api_key'] ? 'text' : 'password'}
                    value={formData.openai_api_key}
                    onChange={(e) => handleChange('openai_api_key', e.target.value)}
                    placeholder={isSecretSet('openai_api_key') ? '••••••••' : 'sk-...'}
                  />
                  <button
                    type="button"
                    onClick={() => toggleShowSecret('openai_api_key')}
                    className="toggle-visibility"
                  >
                    {showSecrets['openai_api_key'] ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              <div className="form-group">
                <label>Chat Model</label>
                <select
                  value={formData.openai_model}
                  onChange={(e) => handleChange('openai_model', e.target.value)}
                >
                  {currentProvider?.models?.chat?.map(model => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label>TTS Model</label>
                <select
                  value={formData.openai_tts_model}
                  onChange={(e) => handleChange('openai_tts_model', e.target.value)}
                >
                  {currentProvider?.models?.tts?.map(model => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label>TTS Voice</label>
                <select
                  value={formData.openai_tts_voice}
                  onChange={(e) => handleChange('openai_tts_voice', e.target.value)}
                >
                  {currentProvider?.voices?.map(voice => (
                    <option key={voice} value={voice}>{voice}</option>
                  ))}
                </select>
              </div>
            </>
          )}
        </section>

        {/* Wallabag Settings */}
        <section className="settings-section">
          <h3>
            <Globe size={20} />
            Wallabag Sync
          </h3>

          {/* Instructions */}
          <div style={{
            padding: '0.75rem',
            background: '#1e3a5f',
            borderRadius: '0.5rem',
            fontSize: '0.875rem',
            lineHeight: '1.5',
            marginBottom: '1rem',
            border: '1px solid #2563eb'
          }}>
            <strong>How to connect:</strong>
            <ol style={{ marginTop: '0.5rem', paddingLeft: '1.25rem' }}>
              <li>Log into your Wallabag instance</li>
              <li>Go to <strong>Settings → API clients management</strong></li>
              <li>Create a new client (name: "Wallacast")</li>
              <li>Copy the <strong>Client ID</strong> and <strong>Client Secret</strong></li>
              <li>Enter those credentials below along with your Wallabag URL, username, and password</li>
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
                  <button
                    type="button"
                    onClick={() => toggleShowSecret('wallabag_client_secret')}
                    className="toggle-visibility"
                  >
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
                  <button
                    type="button"
                    onClick={() => toggleShowSecret('wallabag_password')}
                    className="toggle-visibility"
                  >
                    {showSecrets['wallabag_password'] ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              {/* Connection Test */}
              <div className="form-group" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.5rem' }}>
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
                  onClick={handlePullFromWallabag}
                  disabled={syncing || connectionStatus !== 'success'}
                  className="test-connection-button"
                  style={{ background: '#059669' }}
                >
                  {syncing ? 'Syncing...' : 'Pull from Wallabag'}
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

              {/* Sync Result */}
              {syncResult && (
                <div className="form-group" style={{
                  padding: '0.5rem',
                  background: syncResult.errors.length > 0 ? '#fff3cd' : '#d4edda',
                  borderRadius: '4px',
                  fontSize: '0.9rem',
                  color: syncResult.errors.length > 0 ? '#856404' : '#155724'
                }}>
                  <strong>Pulled: {syncResult.pulled} items</strong>
                  {syncResult.errors.length > 0 && (
                    <>
                      <br />
                      <span style={{ color: '#c33' }}>{syncResult.errors.length} error(s) - check console</span>
                    </>
                  )}
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
                      <strong>Last Sync:</strong> {new Date(wallabagStatus.lastSync).toLocaleString()}
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
