import { useState, useEffect, useRef } from 'react';
import { Rss, Plus, Library, Settings, LogOut, ChevronDown } from 'lucide-react';
import { FeedTab } from './components/FeedTab';
import { AddTab } from './components/AddTab';
import { LibraryTab } from './components/LibraryTab';
import { AudioPlayer } from './components/AudioPlayer';
import { LoginPage } from './components/LoginPage';
import { SettingsPage } from './components/SettingsPage';
import { useContentStore } from './store/contentStore';
import { useAuthStore } from './store/authStore';
import type { ContentItem } from './types';
import './App.css';

type Tab = 'feed' | 'add' | 'library';
type Page = 'main' | 'settings';

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('library');
  const [currentPage, setCurrentPage] = useState<Page>('main');
  const [currentContent, setCurrentContent] = useState<ContentItem | null>(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  // Auth state
  const { user, isAuthenticated, isLoading, checkAuth, logout } = useAuthStore();

  // Get addItem from store for AddTab to use
  const { addItem } = useContentStore();

  // Check auth on mount
  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Close user menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handlePlayContent = (content: ContentItem) => {
    setCurrentContent(content);
  };

  // Callback for AddTab when content is added
  const handleContentAdded = (item: ContentItem) => {
    addItem(item);
  };

  const handleLogout = async () => {
    setShowUserMenu(false);
    await logout();
  };

  const handleOpenSettings = () => {
    setShowUserMenu(false);
    setCurrentPage('settings');
  };

  // Show loading while checking auth
  if (isLoading) {
    return (
      <div className="app loading-screen">
        <div className="loading-content">
          <h1>Wallacast</h1>
          <div className="loading-spinner"></div>
        </div>
      </div>
    );
  }

  // Show login if not authenticated
  if (!isAuthenticated) {
    return <LoginPage />;
  }

  // Show settings page
  if (currentPage === 'settings') {
    return <SettingsPage onBack={() => setCurrentPage('main')} />;
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Wallacast</h1>

        <div className="user-menu-container" ref={userMenuRef}>
          <button
            className="user-menu-trigger"
            onClick={() => setShowUserMenu(!showUserMenu)}
          >
            <span>Hi, {user?.display_name || user?.username}</span>
            <ChevronDown size={16} className={showUserMenu ? 'rotated' : ''} />
          </button>

          {showUserMenu && (
            <div className="user-dropdown">
              <div className="user-dropdown-header">
                <div className="user-avatar">
                  {(user?.display_name || user?.username || 'U').charAt(0).toUpperCase()}
                </div>
                <div className="user-info">
                  <span className="user-name">{user?.display_name || user?.username}</span>
                  <span className="user-username">@{user?.username}</span>
                </div>
              </div>

              <div className="user-dropdown-divider" />

              <button className="user-dropdown-item" onClick={handleOpenSettings}>
                <Settings size={18} />
                <span>Settings</span>
              </button>

              <button className="user-dropdown-item" onClick={handleLogout}>
                <LogOut size={18} />
                <span>Switch Account</span>
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="app-main">
        {activeTab === 'feed' && <FeedTab />}
        {activeTab === 'add' && <AddTab onContentAdded={handleContentAdded} />}
        {activeTab === 'library' && (
          <LibraryTab onPlayContent={handlePlayContent} />
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
