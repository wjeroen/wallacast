import { useState, useEffect, useRef } from 'react';
import { Rss, Plus, Library, Settings, LogOut, ChevronDown, RefreshCw, Volume2, Sun, Moon } from 'lucide-react';
import { FeedTab } from './components/FeedTab';
import { AddTab } from './components/AddTab';
import { LibraryTab } from './components/LibraryTab';
import { AudioPlayer } from './components/AudioPlayer';
import { LoginPage } from './components/LoginPage';
import { SettingsPage } from './components/SettingsPage';
import { useContentStore } from './store/contentStore';
import { useAuthStore } from './store/authStore';
import { wallabagAPI, contentAPI, podcastAPI, userSettingsAPI } from './api';
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

  // Dark/light mode
  const [isDark, setIsDark] = useState(() => {
    try { return localStorage.getItem('wallacast-theme') !== 'light'; }
    catch { return true; }
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    try { localStorage.setItem('wallacast-theme', isDark ? 'dark' : 'light'); }
    catch {}
  }, [isDark]);

  // Auth state
  const { user, isAuthenticated, isLoading, checkAuth, logout } = useAuthStore();

  // Get addItem and fetchContent from store
  const { items: allContent, addItem, fetchContent, refreshItem } = useContentStore();

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

  const handleGenerateAudio = async (regenerate: boolean) => {
    if (!currentContent) return;

    // Warn if article has many comments (but don't block — user can still proceed)
    if (currentContent.comment_count && currentContent.comment_count > 0) {
      try {
        const res = await userSettingsAPI.get('max_narrated_comments');
        const maxComments = res.data.value ? parseInt(res.data.value, 10) || 50 : 50;
        if (currentContent.comment_count > maxComments) {
          const proceed = confirm(
            `This article has ${currentContent.comment_count} comments (your auto-generate limit is ${maxComments}). ` +
            `Generating audio with this many comments may take a long time. Continue?`
          );
          if (!proceed) return;
        }
      } catch { /* use default — no warning if setting fetch fails */ }
    }

    try {
      await contentAPI.generateAudio(currentContent.id, regenerate);
      setTimeout(async () => {
        const response = await contentAPI.getById(currentContent.id);
        setCurrentContent(response.data);
      }, 1000);
    } catch (error: any) {
      console.error('Failed to generate audio:', error);
      alert(error?.response?.data?.error || 'Failed to generate audio');
    }
  };

  const handleRemoveAudio = async () => {
    if (!currentContent) return;
    try {
      await contentAPI.update(currentContent.id, { audio_data: null, audio_url: null } as any);
      const response = await contentAPI.getById(currentContent.id);
      setCurrentContent(response.data);
    } catch (error) {
      console.error('Failed to remove audio:', error);
      alert('Failed to remove audio');
    }
  };

  const handleRegenerateTranscript = async () => {
    if (!currentContent) return;
    try {
      await contentAPI.update(currentContent.id, { regenerate_transcript: true } as any);
      setTimeout(async () => {
        const response = await contentAPI.getById(currentContent.id);
        setCurrentContent(response.data);
      }, 1000);
    } catch (error) {
      console.error('Failed to regenerate transcript:', error);
      alert('Failed to regenerate transcript');
    }
  };

  // Callback for AddTab when content is added
  const handleContentAdded = (item: ContentItem) => {
    addItem(item);
  };

  const handleBulkGenerateAudio = async () => {
    setShowUserMenu(false);

    // Fetch user's max comment limit
    let COMMENT_THRESHOLD = 50;
    try {
      const res = await userSettingsAPI.get('max_narrated_comments');
      if (res.data.value) COMMENT_THRESHOLD = parseInt(res.data.value, 10) || 50;
    } catch { /* use default */ }

    const allEligible = allContent.filter(
      item => item.type === 'article' && !item.is_archived && !item.audio_url &&
              (!item.generation_status || item.generation_status === 'idle' || item.generation_status === 'failed')
    );

    if (allEligible.length === 0) {
      alert('No articles need audio generation.');
      return;
    }

    // Split into generateable and skipped (too many comments)
    const eligibleItems = allEligible.filter(item => !item.comment_count || item.comment_count < COMMENT_THRESHOLD);
    const skippedItems = allEligible.filter(item => item.comment_count && item.comment_count >= COMMENT_THRESHOLD);

    let message = `Generate audio for ${eligibleItems.length} article${eligibleItems.length !== 1 ? 's' : ''}?`;
    if (skippedItems.length > 0) {
      message += `\n\nSkipping ${skippedItems.length} article${skippedItems.length !== 1 ? 's' : ''} with ${COMMENT_THRESHOLD}+ comments. Generate those manually.`;
    }

    if (eligibleItems.length === 0) {
      alert(`All ${allEligible.length} article${allEligible.length !== 1 ? 's' : ''} have ${COMMENT_THRESHOLD}+ comments. Generate audio manually for these.`);
      return;
    }

    const confirmed = confirm(message);
    if (!confirmed) return;

    let started = 0;
    for (const item of eligibleItems) {
      try {
        await contentAPI.generateAudio(item.id, false);
        started++;
        refreshItem(item.id);
      } catch (error) {
        console.error(`Failed to start audio generation for item ${item.id}:`, error);
      }
    }

    if (started > 0) {
      let summary = `Started audio generation for ${started} article${started !== 1 ? 's' : ''}.`;
      if (skippedItems.length > 0) {
        summary += ` Skipped ${skippedItems.length} with ${COMMENT_THRESHOLD}+ comments.`;
      }
      alert(summary);
    }
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

              <button className="user-dropdown-item" onClick={() => { setIsDark(d => !d); }}>
                {isDark ? <Sun size={18} /> : <Moon size={18} />}
                <span>{isDark ? 'Light mode' : 'Dark mode'}</span>
              </button>

              <button className="user-dropdown-item" onClick={handleBulkGenerateAudio}>
                <Volume2 size={18} />
                <span>Generate All Audio</span>
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
        {activeTab === 'feed' && <FeedTab onRefreshComplete={() => setFeedDaysStale(0)} />}
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
            onGenerateAudio={handleGenerateAudio}
            onRemoveAudio={handleRemoveAudio}
            onRegenerateTranscript={handleRegenerateTranscript}
            onContentUpdated={(updated) => setCurrentContent(updated)}
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
