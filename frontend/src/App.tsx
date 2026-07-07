import { useState, useEffect, useRef } from 'react';
import { Rss, Plus, Library, Settings, LogOut, ChevronDown, RefreshCw, Volume2, FileText, Sun, Moon, SunMoon } from 'lucide-react';
import { FeedTab } from './components/FeedTab';
import { AddTab } from './components/AddTab';
import { LibraryTab } from './components/LibraryTab';
import { AudioPlayer } from './components/AudioPlayer';
import { HomePage } from './components/HomePage';
import { SettingsPage } from './components/SettingsPage';
import { useContentStore } from './store/contentStore';
import { useAuthStore } from './store/authStore';
import { useQueueStore } from './store/queueStore';
import { wallabagAPI, contentAPI, podcastAPI, userSettingsAPI } from './api';
import type { ContentItem } from './types';
import './App.css';

type Tab = 'feed' | 'add' | 'library';
type Page = 'main' | 'settings';

// generation_status values that mean "still working". Anything else
// ('completed' | 'failed' | 'idle' | 'content_ready') is treated as terminal
// by pollOperationThenRefresh. 'fetching' is the status a refetch sets while it runs.
// 'ready' is deliberately NOT in this list: it means the audio is saved, but Whisper
// transcription and LLM alignment can still be running afterwards. A 'ready' item only
// counts as still-working while current_operation is set (e.g. 'transcribing' or
// 'aligning_content'). Once current_operation is NULL the item is at rest, even if a past
// crash left it stuck on 'ready'. So pollOperationThenRefresh keys on BOTH fields for 'ready'.
const GENERATION_IN_PROGRESS = ['starting', 'fetching', 'extracting_content', 'generating_audio', 'generating_transcript'];

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('library');
  const [currentPage, setCurrentPage] = useState<Page>('main');
  const [currentContent, setCurrentContent] = useState<ContentItem | null>(null);
  // Which fullscreen-player tab to open on next play (e.g. "Read more" → Summary tab)
  const [initialPlayerTab, setInitialPlayerTab] = useState<'summary' | undefined>(undefined);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const [commentWarning, setCommentWarning] = useState<{ regenerate: boolean; commentCount: number; maxComments: number } | null>(null);
  // Podcast summaries need a transcript first. Confirm before running Whisper + summary
  const [summaryTranscriptWarning, setSummaryTranscriptWarning] = useState(false);
  // Same warning for "Generate All Summaries" when the batch contains untranscribed podcasts
  const [bulkSummaryWarning, setBulkSummaryWarning] = useState<{ podcastIds: number[]; readyIds: number[] } | null>(null);

  // Toast shown when the read-only demo account hits a blocked write (the api.ts
  // interceptor broadcasts the event on any 403 with { demo: true }).
  const [showDemoToast, setShowDemoToast] = useState(false);
  const demoToastTimer = useRef<number | null>(null);
  useEffect(() => {
    const onBlocked = () => {
      setShowDemoToast(true);
      if (demoToastTimer.current) window.clearTimeout(demoToastTimer.current);
      demoToastTimer.current = window.setTimeout(() => setShowDemoToast(false), 2500);
    };
    window.addEventListener('wallacast-demo-blocked', onBlocked);
    return () => {
      window.removeEventListener('wallacast-demo-blocked', onBlocked);
      if (demoToastTimer.current) window.clearTimeout(demoToastTimer.current);
    };
  }, []);

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
    try { localStorage.setItem('wallacast-theme', themeMode); } catch { /* private mode */ }
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
          // Poll the LEAN status endpoint, not getById (which ships the whole item every
          // 5s per pending id). Only fetch the full item once, when audio generation is done.
          const statuses = await contentAPI.getStatuses([id]);
          const status = statuses.data[0];
          if (!status) continue;
          if (status.generation_status === 'completed') {
            const res = await contentAPI.getById(id);
            if (res.data.audio_url) {
              await qs.addToFront(id);
              refreshItem(id);
            }
            // 'completed' is terminal, so stop polling this id either way.
            qs.clearPendingRequeue(id);
          } else if (status.generation_status === 'failed') {
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

      const { pulled, pushed, errors } = response.data;
      // pulled/pushed only count entries that actually CHANGED (the backend checks many
      // more and skips the up-to-date ones), so say so instead of a scary raw number.
      let message = pulled === 0 && pushed === 0
        ? 'Sync complete: everything already in sync'
        : `Sync complete: ${pulled} updated from Wallabag, ${pushed} pushed`;
      if (errors.length > 0) {
        console.warn('Sync completed with errors:', errors);
        message += `, ${errors.length} error${errors.length !== 1 ? 's' : ''} (see server logs)`;
      }
      alert(message);
    } catch (err) {
      console.error('Sync failed:', err);
      alert('Sync failed. Check your connection and try again.');
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
  // auto-queue can be derived from it. Does NOT bump autoPlayToken, as first
  // click should load the track, not play it automatically.
  const handlePlayContent = (content: ContentItem, opts?: { tab?: 'summary' }) => {
    const { typeFilter, statusFilter, searchQuery } = useContentStore.getState();
    useQueueStore.getState().setLibraryContext({ typeFilter, statusFilter, searchQuery }, content.id);
    setInitialPlayerTab(opts?.tab);
    setCurrentContent(content);
  };

  // Play a queue item explicitly (clicking a row in the Queue tab). Accepts
  // either a manual QueueItem or a derived non-manual ContentItem. Items
  // without audio trigger the generate-or-skip prompt (only manuals can be
  // in this state, non-manual stream filters audio-less items out).
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
    if (!queueRow) return; // defensive, should not happen
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
  // Regardless of mode, the current manual item is cleared first (it's been
  // played or skipped).
  // `mode` = 'ended': track ended naturally. Respects autoplay gating via getNextItem.
  // `mode` = 'skip': user hit skip-next. Ignores autoplay gating via peekNextItem.
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
      // Manual item without audio, prompt user
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
      // Loop, try the new "next" after mutation
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
    let item: ContentItem;
    try {
      const res = await contentAPI.getById(prev.id);
      item = res.data;
    } catch {
      item = prev;
    }
    // If the track was nearly or fully finished, restart from the beginning.
    // 10 seconds is the industry-standard threshold (Apple Podcasts, Pocket Casts).
    const pos = item.playback_position || 0;
    const dur = item.duration || 0;
    if (dur > 0 && pos > 0 && (dur - pos) < 10) {
      item = { ...item, playback_position: 0 };
    }
    setCurrentContent(item);
    setAutoPlayToken(t => t + 1);
  };

  // Derived: is there a next/prev track from where we are right now?
  // Both use the "peek" variants. The UI buttons always enable as long
  // as there's somewhere to go, regardless of autoplay gating.
  const hasPrevTrack = !!useQueueStore.getState().getPrevItem(currentContent?.id ?? null);
  const hasNextTrack = !!useQueueStore.getState().peekNextItem(currentContent?.id ?? null);

  // Shared "fire an operation, then refresh once it finishes" helper. Polls the LEAN
  // status endpoint every 2s (getStatuses, a few hundred bytes) until generation
  // leaves its in-progress state, THEN fetches the full item exactly once via getById and
  // applies it to BOTH the open player (if still on that item) and the library store (so
  // cards stop going stale). Replaces the old one-shot 1s setTimeout reloads that always
  // lost the race (refetch takes >1s, transcription takes minutes) and never touched the store.
  // Refetch sets generation_status 'fetching' while it runs (then 'completed'/'failed'), so
  // this correctly waits it out just like audio/transcript generation.
  const pollOperationThenRefresh = (id: number) => {
    let tries = 0;
    const maxTries = 300; // ~10 minutes at 2s intervals
    const poll = async () => {
      tries++;
      try {
        const statuses = await contentAPI.getStatuses([id]);
        const status = statuses.data[0];
        // Push the cheap status fields into the store on EVERY tick, so the library card
        // shows the progress banner for player-started operations too. Cards render from
        // the store, and it used to learn about the operation only at the very end.
        if (status) useContentStore.getState().updateItem(id, status);
        // 'ready' means the audio landed, but transcription/alignment may still be running,
        // so keep polling while current_operation is set (it goes NULL when the item rests).
        const gs = status?.generation_status || '';
        const inProgress = !!status && (GENERATION_IN_PROGRESS.includes(gs)
          || (gs === 'ready' && !!status.current_operation));
        if (inProgress && tries < maxTries) {
          setTimeout(poll, 2000);
          return;
        }
        // Done (or gave up): fetch the full item once, apply to player + store.
        const response = await contentAPI.getById(id);
        setCurrentContent(prev => (prev && prev.id === id ? response.data : prev));
        useContentStore.getState().updateItem(id, response.data);
      } catch (err) {
        console.error('pollOperationThenRefresh failed:', err);
      }
    };
    // First tick immediately: the start endpoints set their in-progress status before
    // responding, so the card banner appears right away instead of after two seconds.
    poll();
  };

  const handleRefetchContent = async () => {
    if (!currentContent) return;

    try {
      await contentAPI.refetch(currentContent.id);
      pollOperationThenRefresh(currentContent.id);
    } catch (error) {
      console.error('Failed to refetch content:', error);
    }
  };

  const doGenerateAudio = async (regenerate: boolean, excludeComments: boolean) => {
    if (!currentContent) return;
    try {
      await contentAPI.generateAudio(currentContent.id, regenerate, excludeComments);
      pollOperationThenRefresh(currentContent.id);
    } catch (error: any) {
      console.error('Failed to generate audio:', error);
      alert(error?.response?.data?.error || 'Failed to generate audio');
    }
  };

  const handleGenerateAudio = async (regenerate: boolean) => {
    if (!currentContent) return;

    if (currentContent.comment_count && currentContent.comment_count > 0) {
      let maxComments = 50;
      try {
        const res = await userSettingsAPI.get('max_narrated_comments');
        if (res.data.value) maxComments = parseInt(res.data.value, 10) || 50;
      } catch { /* use default */ }
      if (currentContent.comment_count > maxComments) {
        setCommentWarning({ regenerate, commentCount: currentContent.comment_count, maxComments });
        return;
      }
    }

    doGenerateAudio(regenerate, false);
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

  const startSummaryGeneration = async (regenerate: boolean, generateTranscript: boolean) => {
    if (!currentContent) return;
    const id = currentContent.id;
    try {
      await contentAPI.generateSummary(id, regenerate, generateTranscript);
      // Reflect "generating" immediately in BOTH the open player and the library store, so
      // the card badge and the LibraryTab poller kick in for player-started summaries too.
      setCurrentContent(prev => (prev && prev.id === id ? { ...prev, summary_status: 'generating' } : prev));
      useContentStore.getState().updateItem(id, { summary_status: 'generating' });
      let tries = 0;
      const maxTries = generateTranscript ? 200 : 30; // transcription first can take many minutes
      // Poll the LEAN status endpoint (a few hundred bytes) instead of getById (which
      // ships the full transcript + word timestamps + alignment every tick). Only when
      // summary_status leaves 'generating' do we fetch the full item once.
      const poll = async () => {
        tries++;
        try {
          const statuses = await contentAPI.getStatuses([id]);
          const status = statuses.data[0];
          if (status) useContentStore.getState().updateItem(id, status);
          if (status && status.summary_status === 'generating' && tries < maxTries) {
            // Reflect the cheap status fields so the UI keeps animating, keep polling.
            setCurrentContent(prev => (prev && prev.id === id ? { ...prev, ...status } : prev));
            setTimeout(poll, 3000);
          } else {
            // Summary finished (or we hit the try cap). Fetch the full item once and apply
            // it to the player AND the store so the card learns the final state too.
            const response = await contentAPI.getById(id);
            setCurrentContent(prev => (prev && prev.id === id ? response.data : prev));
            useContentStore.getState().updateItem(id, response.data);
          }
        } catch {
          /* stop polling on error */
        }
      };
      setTimeout(poll, 3000);
    } catch (error: any) {
      console.error('Failed to generate summary:', error);
      alert(error?.response?.data?.error || 'Failed to generate summary');
    }
  };

  const handleGenerateSummary = async (regenerate: boolean) => {
    if (!currentContent) return;
    // Podcast summaries are made from the TRANSCRIPT. If there is none yet, confirm
    // before running Whisper + summary back to back
    if (currentContent.type === 'podcast_episode' && !(currentContent.transcript || '').trim()) {
      setSummaryTranscriptWarning(true);
      return;
    }
    await startSummaryGeneration(regenerate, false);
  };

  const handleRemoveSummary = async () => {
    if (!currentContent) return;
    const id = currentContent.id;
    try {
      await contentAPI.update(id, { summary: null } as any);
      const response = await contentAPI.getById(id);
      setCurrentContent(prev => (prev && prev.id === id ? response.data : prev));
    } catch (error) {
      console.error('Failed to remove summary:', error);
      alert('Failed to remove summary');
    }
  };

  const handleRegenerateTranscript = async () => {
    if (!currentContent) return;
    try {
      await contentAPI.update(currentContent.id, { regenerate_transcript: true } as any);
      pollOperationThenRefresh(currentContent.id);
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
      item => (item.type === 'article' || item.type === 'text') && !item.is_archived && !item.audio_url &&
              (!item.generation_status || item.generation_status === 'idle' || item.generation_status === 'failed')
    );

    if (allEligible.length === 0) {
      alert('No items need audio generation.');
      return;
    }

    // Split into generateable and skipped (too many comments)
    const eligibleItems = allEligible.filter(item => !item.comment_count || item.comment_count < COMMENT_THRESHOLD);
    const skippedItems = allEligible.filter(item => item.comment_count && item.comment_count >= COMMENT_THRESHOLD);

    let message = `Generate audio for ${eligibleItems.length} item${eligibleItems.length !== 1 ? 's' : ''}?`;
    if (skippedItems.length > 0) {
      message += `\n\nSkipping ${skippedItems.length} item${skippedItems.length !== 1 ? 's' : ''} with ${COMMENT_THRESHOLD}+ comments. Generate those manually.`;
    }

    if (eligibleItems.length === 0) {
      alert(`All ${allEligible.length} item${allEligible.length !== 1 ? 's' : ''} have ${COMMENT_THRESHOLD}+ comments. Generate audio manually for these.`);
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

  // Kick off summaries for a mixed batch: readyIds summarize directly; podcastIds get
  // a transcript first (generate_transcript=true), then the summary chains server-side.
  const startBulkSummaries = async (readyIds: number[], podcastIds: number[]) => {
    const podcastSet = new Set(podcastIds);
    let started = 0;
    for (const id of [...readyIds, ...podcastIds]) {
      try {
        await contentAPI.generateSummary(id, false, podcastSet.has(id));
        started++;
        refreshItem(id);
      } catch (error) {
        console.error(`Failed to start summary generation for item ${id}:`, error);
      }
    }
    if (started > 0) {
      alert(`Started summary generation for ${started} item${started !== 1 ? 's' : ''}.`);
    }
  };

  const handleBulkGenerateSummaries = async () => {
    setShowUserMenu(false);

    // No comment cutoff for summaries. Eligible = articles/texts/podcasts without a
    // summary and not already generating one. Podcasts summarize their transcript,
    // episodes without one get the transcript-first warning below.
    const eligibleItems = allContent.filter(
      item => (item.type === 'article' || item.type === 'text' || item.type === 'podcast_episode') && !item.is_archived &&
              !item.summary_generated_at && item.summary_status !== 'generating'
    );

    if (eligibleItems.length === 0) {
      alert('No items need a summary.');
      return;
    }

    const podcastIds = eligibleItems.filter(i => i.type === 'podcast_episode' && !i.transcript_words).map(i => i.id);
    const readyIds = eligibleItems.filter(i => !(i.type === 'podcast_episode' && !i.transcript_words)).map(i => i.id);

    if (podcastIds.length > 0) {
      setBulkSummaryWarning({ podcastIds, readyIds });
      return;
    }

    const confirmed = confirm(`Generate summaries for ${readyIds.length} item${readyIds.length !== 1 ? 's' : ''}?`);
    if (!confirmed) return;

    await startBulkSummaries(readyIds, []);
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

  // Logged out: the marketing home page (login lives in its top-right dropdown)
  if (!isAuthenticated) {
    return <HomePage />;
  }

  // Show settings page
  if (currentPage === 'settings') {
    return <SettingsPage onBack={() => setCurrentPage('main')} />;
  }

  return (
    <div className="app">
      {user?.demo && (
        <div className="demo-banner">
          <span>You are browsing the read-only demo.</span>
          <button onClick={() => logout()}>Exit demo</button>
        </div>
      )}
      {showDemoToast && <div className="demo-toast">Not available in the read-only demo</div>}
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
                {themeMode === 'dark' ? <Moon size={18} /> : themeMode === 'light' ? <Sun size={18} /> : <SunMoon size={18} />}
                <span>{themeMode === 'dark' ? 'Dark' : themeMode === 'light' ? 'Light' : 'System'}</span>
              </button>

              <button className="user-dropdown-item" onClick={handleBulkGenerateAudio}>
                <Volume2 size={18} />
                <span>Generate All Audio</span>
              </button>

              <button className="user-dropdown-item" onClick={handleBulkGenerateSummaries}>
                <FileText size={18} />
                <span>Generate Summaries</span>
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
            onGenerateSummary={handleGenerateSummary}
            onRemoveSummary={handleRemoveSummary}
            onRegenerateTranscript={handleRegenerateTranscript}
            onContentUpdated={(updated) => setCurrentContent(updated)}
            initialTab={initialPlayerTab}
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

      {commentWarning && (
        <div className="comment-warning-overlay" onClick={() => setCommentWarning(null)}>
          <div className="comment-warning-modal" onClick={e => e.stopPropagation()}>
            <p>This article has <strong>{commentWarning.commentCount} comments</strong> (your auto-generate limit is {commentWarning.maxComments}). Generating audio with this many comments may take a long time.</p>
            <div className="comment-warning-buttons">
              <button
                className="comment-warning-btn exclude"
                onClick={() => {
                  const { regenerate } = commentWarning;
                  setCommentWarning(null);
                  doGenerateAudio(regenerate, true);
                }}
              >
                Exclude comments
              </button>
              <button
                className="comment-warning-btn include"
                onClick={() => {
                  const { regenerate } = commentWarning;
                  setCommentWarning(null);
                  doGenerateAudio(regenerate, false);
                }}
              >
                Include comments
              </button>
              <button
                className="comment-warning-btn cancel"
                onClick={() => setCommentWarning(null)}
              >
                Don't generate audio
              </button>
            </div>
          </div>
        </div>
      )}

      {bulkSummaryWarning && (
        <div className="comment-warning-overlay" onClick={() => setBulkSummaryWarning(null)}>
          <div className="comment-warning-modal" onClick={e => e.stopPropagation()}>
            <p>
              <strong>{bulkSummaryWarning.podcastIds.length} podcast episode{bulkSummaryWarning.podcastIds.length > 1 ? 's' : ''}</strong> {bulkSummaryWarning.podcastIds.length > 1 ? 'have' : 'has'} no transcript yet. Podcast summaries are made from the transcript, so those need to be generated first (this uses your transcription API credits). Summaries follow automatically.
              {bulkSummaryWarning.readyIds.length > 0 && (
                <> The other {bulkSummaryWarning.readyIds.length} item{bulkSummaryWarning.readyIds.length > 1 ? 's' : ''} can be summarized right away.</>
              )}
            </p>
            <div className="comment-warning-buttons">
              <button
                className="comment-warning-btn include"
                onClick={() => {
                  const w = bulkSummaryWarning;
                  setBulkSummaryWarning(null);
                  startBulkSummaries(w.readyIds, w.podcastIds);
                }}
              >
                Generate transcripts + summaries
              </button>
              {bulkSummaryWarning.readyIds.length > 0 && (
                <button
                  className="comment-warning-btn exclude"
                  onClick={() => {
                    const w = bulkSummaryWarning;
                    setBulkSummaryWarning(null);
                    startBulkSummaries(w.readyIds, []);
                  }}
                >
                  Skip episodes without transcript
                </button>
              )}
              <button
                className="comment-warning-btn cancel"
                onClick={() => setBulkSummaryWarning(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {summaryTranscriptWarning && (
        <div className="comment-warning-overlay" onClick={() => setSummaryTranscriptWarning(false)}>
          <div className="comment-warning-modal" onClick={e => e.stopPropagation()}>
            <p>This episode has <strong>no transcript</strong> yet. Podcast summaries are made from the transcript, so one needs to be generated first (this uses your transcription API credits). The summary follows automatically.</p>
            <div className="comment-warning-buttons">
              <button
                className="comment-warning-btn include"
                onClick={() => {
                  setSummaryTranscriptWarning(false);
                  startSummaryGeneration(false, true);
                }}
              >
                Generate transcript + summary
              </button>
              <button
                className="comment-warning-btn cancel"
                onClick={() => setSummaryTranscriptWarning(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
