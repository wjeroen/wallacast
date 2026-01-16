import { useState, useEffect, useCallback } from 'react';
import { Rss, Plus, Library } from 'lucide-react';
import { FeedTab } from './components/FeedTab';
import { AddTab } from './components/AddTab';
import { LibraryTab } from './components/LibraryTab';
import { AudioPlayer } from './components/AudioPlayer';
import { contentAPI } from './api';
import type { ContentItem } from './types';
import './App.css';

type Tab = 'feed' | 'add' | 'library';

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('library');
  const [currentContent, setCurrentContent] = useState<ContentItem | null>(null);
  const [content, setContent] = useState<ContentItem[]>([]);
  const [contentLoading, setContentLoading] = useState(false);

  const loadContent = useCallback(async (params?: any) => {
    setContentLoading(true);
    try {
      const response = await contentAPI.getAll(params || {});
      setContent(response.data);
    } catch (error) {
      console.error('Failed to load content:', error);
    } finally {
      setContentLoading(false);
    }
  }, []);

  const handlePlayContent = (content: ContentItem) => {
    setCurrentContent(content);
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Readcast</h1>
      </header>

      <main className="app-main">
        {activeTab === 'feed' && <FeedTab />}
        {activeTab === 'add' && <AddTab onContentAdded={loadContent} />}
        {activeTab === 'library' && (
          <LibraryTab
            onPlayContent={handlePlayContent}
            content={content}
            setContent={setContent}
            loading={contentLoading}
            onRefresh={loadContent}
          />
        )}
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
    </div>
  );
}

export default App;
