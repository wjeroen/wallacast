import { useState } from 'react';
import { Rss, Plus, Library, Settings as SettingsIcon } from 'lucide-react';
import { FeedTab } from './components/FeedTab';
import { AddTab } from './components/AddTab';
import { LibraryTab } from './components/LibraryTab';
import { AudioPlayer } from './components/AudioPlayer';
import type { ContentItem } from './types';
import './App.css';

type Tab = 'feed' | 'add' | 'library';

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('library');
  const [currentContent, setCurrentContent] = useState<ContentItem | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const handlePlayContent = (content: ContentItem) => {
    setCurrentContent(content);
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
              <p>Settings coming soon...</p>
              <div className="setting-group">
                <h3>API Keys</h3>
                <p>Configure your OpenAI and ElevenLabs API keys in the backend .env file</p>
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
