import { useState, useEffect } from 'react';
import { Rss, Plus, Library, Settings as SettingsIcon } from 'lucide-react';
import { FeedTab } from './components/FeedTab';
import { AddTab } from './components/AddTab';
import { LibraryTab } from './components/LibraryTab';
import { AudioPlayer } from './components/AudioPlayer';
import { settingsAPI } from './api';
import type { ContentItem } from './types';
import './App.css';

type Tab = 'feed' | 'add' | 'library';

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('library');
  const [currentContent, setCurrentContent] = useState<ContentItem | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [saving, setSaving] = useState(false);

  const handlePlayContent = (content: ContentItem) => {
    setCurrentContent(content);
  };

  useEffect(() => {
    if (showSettings) {
      loadApiKey();
    }
  }, [showSettings]);

  const loadApiKey = async () => {
    try {
      const response = await settingsAPI.get('OPENAI_API_KEY');
      setOpenaiApiKey(response.data.value || '');
    } catch (error) {
      console.error('Failed to load API key:', error);
    }
  };

  const saveApiKey = async () => {
    setSaving(true);
    try {
      await settingsAPI.update('OPENAI_API_KEY', openaiApiKey);
      alert('API key saved successfully!');
    } catch (error) {
      console.error('Failed to save API key:', error);
      alert('Failed to save API key. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Readcast</h1>
        <button onClick={() => setShowSettings(!showSettings)} className="settings-btn">
          <SettingsIcon size={24} />
        </button>
      </header>

      <main className="app-main">
        {activeTab === 'feed' && <FeedTab />}
        {activeTab === 'add' && <AddTab />}
        {activeTab === 'library' && <LibraryTab onPlayContent={handlePlayContent} />}
      </main>

      <nav className="bottom-nav">
        <button
          className={activeTab === 'feed' ? 'active' : ''}
          onClick={() => setActiveTab('feed')}
        >
          <Rss size={24} />
          <span>Feed</span>
        </button>
        <button
          className={`add-button ${activeTab === 'add' ? 'active' : ''}`}
          onClick={() => setActiveTab('add')}
        >
          <Plus size={32} />
        </button>
        <button
          className={activeTab === 'library' ? 'active' : ''}
          onClick={() => setActiveTab('library')}
        >
          <Library size={24} />
          <span>Library</span>
        </button>
      </nav>

      {currentContent && (
        <div className="player-container">
          <AudioPlayer content={currentContent} onClose={() => setCurrentContent(null)} />
        </div>
      )}

      {showSettings && (
        <div className="settings-modal">
          <div className="settings-content">
            <div className="settings-header">
              <h2>Settings</h2>
              <button onClick={() => setShowSettings(false)}>×</button>
            </div>
            <div className="settings-body">
              <div className="setting-group">
                <h3>OpenAI API Key</h3>
                <p>Required for transcription and text-to-speech features</p>
                <input
                  type="password"
                  value={openaiApiKey}
                  onChange={(e) => setOpenaiApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="api-key-input"
                />
                <button onClick={saveApiKey} disabled={saving} className="save-btn">
                  {saving ? 'Saving...' : 'Save API Key'}
                </button>
                <p className="api-key-hint">
                  Get your API key from{' '}
                  <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">
                    OpenAI Platform
                  </a>
                </p>
              </div>
              <div className="setting-group">
                <h3>Features</h3>
                <ul>
                  <li>Transcription: gpt-4o-mini-transcribe ($0.006/min)</li>
                  <li>Text-to-Speech: gpt-4o-mini-tts ($0.015/1K chars)</li>
                </ul>
              </div>
              <div className="setting-group">
                <h3>About</h3>
                <p>Readcast - A unified reader and podcast app</p>
                <p>Version 1.0.0</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
