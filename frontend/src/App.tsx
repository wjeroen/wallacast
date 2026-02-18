import { useState, useEffect, useRef } from 'react';
import { Rss, Plus, Library, Settings, LogOut, ChevronDown, RefreshCw } from 'lucide-react';
import { FeedTab } from './components/FeedTab';
import { AddTab } from './components/AddTab';
import { LibraryTab } from './components/LibraryTab';
import { AudioPlayer } from './components/AudioPlayer';
import { LoginPage } from './components/LoginPage';
import { SettingsPage } from './components/SettingsPage';
import { useContentStore } from './store/contentStore';
import { useAuthStore } from './store/authStore';
import { wallabagAPI, contentAPI, podcastAPI } from './api';
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

  // Get addItem and fetchContent from store
  const { addItem, fetchContent } = useContentStore();

  // Feed staleness (days since last refresh)
  const [feedDaysStale, setFeedDaysStale] = useState(0);

  // Wallabag sync state
  const [wallabagEnabled, setWallabagEnabled] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [pendingChanges, setPendingChanges] = useState(0);

  // Check auth on mount
  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Load feed staleness (days since last refresh)
  useEffect(() => {
    if (isAuthenticated) {
      podcastAPI.getLastRefresh().then(res => {
        if (res.data.lastRefresh) {
          const days = Math.floor((Date.now() - new Date(res.data.lastRefresh).getTime()) / 86400000);
          setFeedDaysStale(days);
        }
      }).catch(() => {});
    }
  }, [isAuthenticated]);

  // Load Wallabag status
  useEffect(() => {
    if (isAuthenticated) {
      loadWallabagStatus();
    }
  }, [isAuthenticated]);

  const loadWallabagStatus = async () => {
    try {
      const response = await wallabagAPI.getStatus();
      setWallabagEnabled(response.data.enabled);
      setLastSync(response.data.lastSync);
      setPendingChanges(response.data.pendingChanges);
    } catch (err) {
      // Silently fail - Wallabag is optional
      console.error('Failed to load Wallabag status:', err);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      // Full bidirectional sync: pull from Wallabag, then push local changes
      const response = await wallabagAPI.sync();
      console.log('Sync result:', response.data);

      // Refresh the library to show new items
      await fetchContent();

      // Reload status (pending changes should now be 0)
      await loadWallabagStatus();

      if (response.data.errors.length > 0) {
        console.warn('Sync completed with errors:', response.data.errors);
      }
    } catch (err) {
      console.error('Sync failed:', err);
    } finally {
      setSyncing(false);
    }
  };

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

  const handleRefetchContent = async () => {
    if (!currentContent) return;

    try {
      await contentAPI.refetch(currentContent.id);
      // Wait a bit for the backend to process, then reload
      setTimeout(async () => {
        const response = await contentAPI.getById(currentContent.id);
        setCurrentContent(response.data);
      }, 1000);
    } catch (error) {
      console.error('Failed to refetch content:', error);
    }
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
          <img src="/logo-0f172a.png" alt="wallacast logo" className="loading-logo" />
          <h1>wallacast</h1>
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
        <div className="app-logo-container">
          <img src="/logo-1e293b.png" alt="wallacast logo" className="app-logo" />
          <h1>wallacast</h1>
        </div>

        <div className="header-right">
          {wallabagEnabled && (
            <button
              className="sync-button"
              onClick={handleSync}
              disabled={syncing}
              title={lastSync ? `Last sync: ${new Date(lastSync).toLocaleString()}` : 'Never synced'}
            >
              <RefreshCw size={18} className={syncing ? 'spinning' : ''} />
              <span className="sync-text">
                {syncing ? 'Syncing...' : pendingChanges > 0 ? `Sync (${pendingChanges})` : 'Sync'}
              </span>
            </button>
          )}

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
        </div>
      </header>

      <main className="app-main">
        {activeTab === 'feed' && <FeedTab />}
        {activeTab === 'add' && <AddTab onContentAdded={handleContentAdded} />}
        {activeTab === 'library' && (
          <LibraryTab onPlayContent={handlePlayContent} />
        )}
      </main>

      <div className="bottom-container">
        {currentContent && (
          <AudioPlayer
            content={currentContent}
            onClose={() => setCurrentContent(null)}
            onRefetch={handleRefetchContent}
          />
        )}

        <nav className="bottom-nav">
          <button
            className={activeTab === 'feed' ? 'active' : ''}
            onClick={() => setActiveTab('feed')}
          >
            <Rss size={24} />
            <span>Feed{feedDaysStale >= 1 ? ` (${feedDaysStale})` : ''}</span>
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
      </div>
    </div>
  );
}

export default App;
