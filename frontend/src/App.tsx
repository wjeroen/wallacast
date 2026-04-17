import { useState, useEffect, useRef } from 'react';
import { Rss, Plus, Library, Settings, LogOut, ChevronDown, RefreshCw, Volume2, Sun, Moon, Monitor } from 'lucide-react';
import { FeedTab } from './components/FeedTab';
import { AddTab } from './components/AddTab';
import { LibraryTab } from './components/LibraryTab';
import { AudioPlayer } from './components/AudioPlayer';
import { LoginPage } from './components/LoginPage';
import { SettingsPage } from './components/SettingsPage';
import { useContentStore } from './store/contentStore';
import { useAuthStore } from './store/authStore';
import { useQueueStore } from './store/queueStore';
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

  // Theme: dark | light | system
  type ThemeMode = 'dark' | 'light' | 'system';
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    try {
      const stored = localStorage.getItem('wallacast-theme');
      if (stored === 'light' || stored === 'system') return stored;
      return 'dark';
    } catch { return 'dark'; }
  });
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  const isDark = themeMode === 'dark' || (themeMode === 'system' && systemPrefersDark);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    try { localStorage.setItem('wallacast-theme', themeMode); } catch {}
  }, [isDark, themeMode]);
  const cycleTheme = () => setThemeMode(m => m === 'dark' ? 'light' : m === 'light' ? 'system' : 'dark');

  // Auth state
  const { user, isAuthenticated, isLoading, checkAuth, logout } = useAuthStore();

  // Get addItem and fetchContent from store
  const { items: allContent, addItem, fetchContent, refreshItem } = useContentStore();

  // Queue state (subscribed so hasNext/hasPrev stay reactive across queue edits,
  // library-context changes, shuffle/autoplay toggles, and the setting toggle)
  useQueueStore(s => s.manualItems);
  useQueueStore(s => s.autoplay);
  useQueueStore(s => s.manualAlwaysAutoplay);
  useQueueStore(s => s.libraryContext);
  useQueueStore(s => s.shuffleNonManual);

  // Bump this counter whenever we swap `currentContent` because of an auto-
  // advance or explicit next/prev click. AudioPlayer watches it and auto-plays
  // the new track once metadata loads. First-click from the library leaves it
  // at 0 so playback stays user-initiated.
  const [autoPlayToken, setAutoPlayToken] = useState(0);

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

  // Hydrate queue + autoplay preference once authenticated
  useEffect(() => {
    if (!isAuthenticated) return;
    useQueueStore.getState().fetchQueue();
    useQueueStore.getState().hydrateSettings();
  }, [isAuthenticated]);

  // Poll any items whose audio we started generating from the queue flow.
  // When they finish, re-insert at the front of the manual queue.
  useEffect(() => {
    if (!isAuthenticated) return;
    const interval = setInterval(async () => {
      const qs = useQueueStore.getState();
      if (qs.pendingRequeue.size === 0) return;
      for (const id of Array.from(qs.pendingRequeue)) {
        try {
          const res = await contentAPI.getById(id);
          if (res.data.generation_status === 'completed' && res.data.audio_url) {
            await qs.addToFront(id);
            qs.clearPendingRequeue(id);
            refreshItem(id);
          } else if (res.data.generation_status === 'failed') {
            qs.clearPendingRequeue(id);
          }
        } catch (err) {
          console.error('Pending requeue poll failed:', err);
        }
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [isAuthenticated, refreshItem]);

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

  // Called from LibraryTab when the user clicks a library item. Captures the
  // current filter as a "play context" (Spotify-style) so the non-manual
  // auto-queue can be derived from it. Does NOT bump autoPlayToken — first
  // click should load the track, not play it automatically.
  const handlePlayContent = (content: ContentItem) => {
    const filter = useContentStore.getState().filter;
    useQueueStore.getState().setLibraryContext(filter, content.id);
    setCurrentContent(content);
  };

  // Play a queue item explicitly (clicking a row in the Queue tab). Accepts
  // either a manual QueueItem or a derived non-manual ContentItem. Items
  // without audio trigger the generate-or-skip prompt (only manuals can be
  // in this state — non-manual stream filters audio-less items out).
  const handlePlayQueueItem = async (item: ContentItem) => {
    if (item.audio_url) {
      try {
        const res = await contentAPI.getById(item.id);
        setCurrentContent(res.data);
      } catch {
        setCurrentContent(item);
      }
      setAutoPlayToken(t => t + 1);
      return;
    }
    const qs = useQueueStore.getState();
    const queueRow = qs.manualItems.find(m => m.id === item.id);
    if (!queueRow) return; // defensive — should not happen
    const proceed = confirm(
      `"${item.title}" has no audio yet. Generate it now? Your queue will continue to the next item, and this one will move to the top of the queue once audio is ready.`
    );
    if (!proceed) return;
    qs.markPendingRequeue(item.id);
    await qs.removeFromQueue(queueRow.queue_id);
    try {
      await contentAPI.generateAudio(item.id, false);
      refreshItem(item.id);
    } catch (err: any) {
      console.error('Failed to start audio generation:', err);
      qs.clearPendingRequeue(item.id);
      alert(err?.response?.data?.error || 'Failed to start audio generation');
      return;
    }
    advanceToNextTrack('skip');
  };

  // Advance to the next track in the queue (manual first, then non-manual if
  // autoplay is on). When we hit a manual item with no audio, prompt the user
  // to generate-or-skip, then continue looking for a playable next item.
  //
  // `mode` = 'auto'  — track ended naturally or user hit skip-next. We always
  //                    clear the current manual item (it's been played/skipped).
  // `mode` = 'ended' — respects autoplay gating via getNextItem.
  // `mode` = 'skip'  — ignores autoplay gating via peekNextItem.
  const advanceToNextTrack = async (mode: 'ended' | 'skip') => {
    const currentId = currentContent?.id ?? null;

    if (currentId !== null) {
      const qs0 = useQueueStore.getState();
      const currentRow = qs0.manualItems.find(m => m.id === currentId);
      if (currentRow) qs0.removeFromQueue(currentRow.queue_id);
    }

    while (true) {
      const qs = useQueueStore.getState();
      const nextItem = mode === 'skip'
        ? qs.peekNextItem(currentId)
        : qs.getNextItem(currentId);
      if (!nextItem) {
        return;
      }
      if (nextItem.audio_url) {
        try {
          const res = await contentAPI.getById(nextItem.id);
          setCurrentContent(res.data);
        } catch {
          setCurrentContent(nextItem);
        }
        setAutoPlayToken(t => t + 1);
        return;
      }
      // Manual item without audio — prompt user
      const queueRow = qs.manualItems.find(m => m.id === nextItem.id);
      if (!queueRow) {
        // Defensive: non-manual stream already filters out audio-less items.
        return;
      }
      const shouldGenerate = confirm(
        `"${nextItem.title}" has no audio yet. Generate it now? We'll continue to the next item, and this one will move to the top of the queue when audio is ready.`
      );
      if (shouldGenerate) {
        qs.markPendingRequeue(nextItem.id);
        qs.removeFromQueue(queueRow.queue_id);
        contentAPI.generateAudio(nextItem.id, false)
          .then(() => refreshItem(nextItem.id))
          .catch((err) => {
            console.error('Failed to start audio generation:', err);
            qs.clearPendingRequeue(nextItem.id);
          });
      } else {
        qs.removeFromQueue(queueRow.queue_id);
      }
      // Loop — try the new "next" after mutation
    }
  };

  const handleTrackEnded = () => {
    advanceToNextTrack('ended');
  };

  const handleSkipNext = () => {
    advanceToNextTrack('skip');
  };

  const handleSkipPrev = async () => {
    const prev = useQueueStore.getState().getPrevItem(currentContent?.id ?? null);
    if (!prev) return;
    try {
      const res = await contentAPI.getById(prev.id);
      setCurrentContent(res.data);
    } catch {
      setCurrentContent(prev);
    }
    setAutoPlayToken(t => t + 1);
  };

  // Derived: is there a next/prev track from where we are right now?
  // Both use the "peek" variants — the UI buttons always enable as long
  // as there's somewhere to go, regardless of autoplay gating.
  const hasPrevTrack = !!useQueueStore.getState().getPrevItem(currentContent?.id ?? null);
  const hasNextTrack = !!useQueueStore.getState().peekNextItem(currentContent?.id ?? null);

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
          <img src="/logo-transparent.png" alt="wallacast logo" className="app-logo" />
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

              <button className="user-dropdown-item" onClick={cycleTheme}>
                {themeMode === 'dark' ? <Moon size={18} /> : themeMode === 'light' ? <Sun size={18} /> : <Monitor size={18} />}
                <span>{themeMode === 'dark' ? 'Dark' : themeMode === 'light' ? 'Light' : 'System'}</span>
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
            isDark={isDark}
            themeMode={themeMode}
            onCycleTheme={cycleTheme}
            onTrackEnded={handleTrackEnded}
            onSkipNextTrack={handleSkipNext}
            onSkipPrevTrack={handleSkipPrev}
            hasNextTrack={hasNextTrack}
            hasPrevTrack={hasPrevTrack}
            autoPlayToken={autoPlayToken}
            onPlayQueueItem={handlePlayQueueItem}
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
