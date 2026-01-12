import { useState, useEffect } from 'react';
import { Rss, Plus, Library } from 'lucide-react';
import { FeedTab } from './components/FeedTab';
import { AddTab } from './components/AddTab';
import { LibraryTab } from './components/LibraryTab';
import { AudioPlayer } from './components/AudioPlayer';
import { LoginModal } from './components/LoginModal';
import type { ContentItem } from './types';
import { api } from './api';
import './App.css';

type Tab = 'feed' | 'add' | 'library';

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('library');
  const [currentContent, setCurrentContent] = useState<ContentItem | null>(null);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // Check authentication on mount and set up interceptor
  useEffect(() => {
    // Add response interceptor to handle 401 errors
    const interceptor = api.interceptors.response.use(
      (response: any) => response,
      (error: any) => {
        if (error.response?.status === 401) {
          setIsAuthenticated(false);
          setShowLoginModal(true);
        }
        return Promise.reject(error);
      }
    );

    // Check if already authenticated by trying to fetch content
    api.get('/content')
      .then(() => setIsAuthenticated(true))
      .catch(() => setShowLoginModal(true));

    return () => {
      api.interceptors.response.eject(interceptor);
    };
  }, []);

  const handleLogin = async (username: string, password: string) => {
    // Set basic auth header
    const credentials = btoa(`${username}:${password}`);
    api.defaults.headers.common['Authorization'] = `Basic ${credentials}`;

    // Test authentication
    await api.get('/content');
    setIsAuthenticated(true);
  };

  const handlePlayContent = (content: ContentItem) => {
    setCurrentContent(content);
  };

  return (
    <div className="app">
      {showLoginModal && (
        <LoginModal
          onClose={() => setShowLoginModal(false)}
          onLogin={handleLogin}
        />
      )}

      <header className="app-header">
        <h1>Readcast</h1>
      </header>

      {isAuthenticated ? (
        <>
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
        </>
      ) : (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 'calc(100vh - 60px)',
          color: '#94a3b8',
        }}>
          <p>Please log in to continue...</p>
        </div>
      )}
    </div>
  );
}

export default App;
