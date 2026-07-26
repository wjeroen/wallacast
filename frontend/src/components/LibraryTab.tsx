import { useState, useEffect, useRef, useMemo, type ReactElement } from 'react';
import { Star, StarOff, Archive, ArchiveRestore, Trash2, MoreVertical, Newspaper, NotebookPen, Podcast, X, Search, Inbox, ChevronDown, Check, FunnelX, Volume2, VolumeOff, MessageSquareText, MessageSquareOff, Captions, CaptionsOff, ListChecks, ArrowDownWideNarrow, ArrowUpNarrowWide } from 'lucide-react';
import { contentAPI, userSettingsAPI } from '../api';
import { useContentStore, itemMatchesFilter, type FacetDim, type FacetValue } from '../store/contentStore';
import { useQueueStore } from '../store/queueStore';
import { ContentCard } from './ContentCard';
import { contentToMarkdown } from '../markdown';
import { isVeryLongArticle } from '../format';
import type { ContentItem, Comment } from '../types';

interface LibraryTabProps {
  onPlayContent: (content: ContentItem, opts?: { tab?: 'summary' }) => void;
}

// The 2x5 filter grid: one facet row per dimension, two mutually exclusive
// options per row. Selecting an option deselects its sibling; clicking the
// selected option again clears the row (1-or-none per row). The same icons
// mark the filter button, the library card badges, and the dropdown actions.
const FACET_ROWS: { dim: FacetDim; options: { value: FacetValue; label: string; icon: ReactElement }[] }[] = [
  {
    dim: 'archive',
    options: [
      { value: 'active', label: 'Active', icon: <Inbox size={16} /> },
      { value: 'archived', label: 'Archived', icon: <Archive size={16} style={{ color: '#60a5fa' }} /> },
    ],
  },
  {
    dim: 'star',
    options: [
      { value: 'starred', label: 'Starred', icon: <Star size={16} fill="currentColor" style={{ color: '#fbbf24' }} /> },
      { value: 'unstarred', label: 'No star', icon: <StarOff size={16} /> },
    ],
  },
  {
    dim: 'audio',
    options: [
      { value: 'audio', label: 'Audio', icon: <Volume2 size={16} /> },
      { value: 'no_audio', label: 'No audio', icon: <VolumeOff size={16} /> },
    ],
  },
  {
    dim: 'summary',
    options: [
      { value: 'summary', label: 'Summary', icon: <MessageSquareText size={16} /> },
      { value: 'no_summary', label: 'None', icon: <MessageSquareOff size={16} /> },
    ],
  },
  {
    dim: 'transcript',
    options: [
      { value: 'transcript', label: 'Transcript', icon: <Captions size={16} /> },
      { value: 'no_transcript', label: 'None', icon: <CaptionsOff size={16} /> },
    ],
  },
];

export function LibraryTab({ onPlayContent }: LibraryTabProps) {
  // Use Zustand store for content state
  const {
    items: content,
    allItems,
    typeFilter,
    facets,
    searchQuery,
    sortDir,
    loading,
    setTypeFilter,
    setFacet,
    setFacets,
    setSortDir,
    setSearchQuery,
    fetchContent,
    toggleStarred,
    toggleArchived,
    deleteItem,
    updateItem,
    refreshItem,
  } = useContentStore();

  const [selectedItems, setSelectedItems] = useState<Set<number>>(new Set());
  const [bulkMode, setBulkMode] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<number | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Search bar (expands above the filter row when the search icon is tapped)
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInput, setSearchInput] = useState(''); // immediate value, debounced into the store

  // Status filter funnel menu (Active / Favorites / Archived)
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const statusMenuRef = useRef<HTMLDivElement>(null);

  // Bulk actions overflow menu + sequential progress counter
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);
  const bulkMenuRef = useRef<HTMLDivElement>(null);
  const [bulkProgress, setBulkProgress] = useState<{ label: string; done: number; total: number } | null>(null);

  // Track recently completed items (show "Completed" for 5 seconds)
  const [recentlyCompleted, setRecentlyCompleted] = useState<Map<number, number>>(new Map());
  const [commentWarning, setCommentWarning] = useState<{ id: number; regenerate: boolean; commentCount: number; maxComments: number } | null>(null);
  // Podcasts need a transcript before a summary can be generated, so this modal asks first.
  // readyIds = items that can summarize right away; podcastIds = need transcript first.
  const [transcriptWarning, setTranscriptWarning] = useState<{ podcastIds: number[]; readyIds: number[] } | null>(null);
  // "Twitter feed" mode: show the article summary instead of the description on library cards.
  const [showSummaryInLibrary, setShowSummaryInLibrary] = useState(false);
  // "Continue listening" strip under the filters (Settings toggle, default on).
  const [showContinueStrip, setShowContinueStrip] = useState(true);
  // Confirm before archiving wipes generated audio (Settings toggle, default on).
  const [warnArchiveAudio, setWarnArchiveAudio] = useState(true);

  // Fetch content on mount
  useEffect(() => {
    fetchContent();
  }, []);

  // Load the "show summary on library cards" preference
  useEffect(() => {
    userSettingsAPI.get('library_show_summary')
      .then(res => setShowSummaryInLibrary(res.data.value === 'true'))
      .catch(() => {});
    userSettingsAPI.get('show_continue_listening')
      .then(res => setShowContinueStrip(res.data.value !== 'false'))
      .catch(() => {});
    userSettingsAPI.get('warn_archive_removes_audio')
      .then(res => setWarnArchiveAudio(res.data.value !== 'false'))
      .catch(() => {});
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpenDropdown(null);
      }
    };

    if (openDropdown !== null) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [openDropdown]);

  // Close the status funnel menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (statusMenuRef.current && !statusMenuRef.current.contains(event.target as Node)) {
        setStatusMenuOpen(false);
      }
    };
    if (statusMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [statusMenuOpen]);

  // Close the bulk overflow menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (bulkMenuRef.current && !bulkMenuRef.current.contains(event.target as Node)) {
        setBulkMenuOpen(false);
      }
    };
    if (bulkMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [bulkMenuOpen]);

  // Debounce the search input into the store (the store filters on every change).
  // Also drops the selection, so a select-all from a previous search shouldn't
  // keep acting on now-hidden items.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearchQuery(searchInput);
      setSelectedItems(new Set());
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, setSearchQuery]);

  // Filter changes clear the selection for the same reason
  const changeTypeFilter = (t: Parameters<typeof setTypeFilter>[0]) => {
    setTypeFilter(t);
    setSelectedItems(new Set());
  };
  // Facet rows toggle 1-or-none: clicking the selected option clears the row.
  // The menu deliberately stays OPEN so rows can be combined; it only closes
  // on an outside tap (the click-outside effect above).
  const toggleFacet = (dim: FacetDim, value: FacetValue) => {
    setFacet(dim, facets[dim] === value ? null : value);
    setSelectedItems(new Set());
  };

  // Double-click/tap an option to make it the ONLY selected filter (a hidden
  // "reset to just this"). The two single-click toggles that fire first cancel
  // each other out, so the end state is exactly the solo selection.
  const soloFacet = (dim: FacetDim, value: FacetValue) => {
    setFacets({ archive: null, star: null, audio: null, summary: null, transcript: null, [dim]: value });
    setSelectedItems(new Set());
  };

  // Selection state for the smart star/archive toggles: all-starred → button unstars,
  // otherwise it stars (already-starred items stay starred). Same for archive.
  const selectedObjs = content.filter(i => selectedItems.has(i.id));
  const allSelectedStarred = selectedObjs.length > 0 && selectedObjs.every(i => i.is_starred);
  const allSelectedArchived = selectedObjs.length > 0 && selectedObjs.every(i => i.is_archived);

  // Per-type counts under the current status, ignoring search (so the number
  // stays stable while typing). The count is shown on the ACTIVE type chip.
  const typeCounts = useMemo(() => {
    const counts = { all: 0, articles: 0, texts: 0, podcasts: 0 };
    for (const i of allItems) {
      if (!itemMatchesFilter(i, { typeFilter: 'all', facets, searchQuery: '' })) continue;
      counts.all++;
      if (i.type === 'article') counts.articles++;
      else if (i.type === 'text') counts.texts++;
      else if (i.type === 'podcast_episode') counts.podcasts++;
    }
    return counts;
  }, [allItems, facets]);

  // Poll for progress updates on items that are generating
  useEffect(() => {
    const generatingItems = content.filter(
      item =>
        (item.generation_status && ['starting', 'extracting_content', 'content_ready', 'generating_audio', 'generating_transcript', 'ready'].includes(item.generation_status)) ||
        item.summary_status === 'generating'
    );

    if (generatingItems.length === 0) return;

    // Poll every 2 seconds for active generation.
    // ONE batch request for all generating items. Returns only the small status fields
    // (a few hundred bytes), NOT the full item. Previously this looped getById per item,
    // which shipped the entire transcript + 9k word timestamps + alignment every tick
    // (~0.5MB per transcribed podcast). The full item is still fetched ONCE, at
    // completion, via refreshItem.
    const pollInterval = setInterval(async () => {
      try {
        const ids = generatingItems.map(i => i.id);
        const response = await contentAPI.getStatuses(ids);

        for (const status of response.data) {
          const before = generatingItems.find(i => i.id === status.id);
          if (!before) continue;

          // Merge just the small status fields (progress bar + badges keep animating)
          updateItem(status.id, status);

          const audioJustCompleted =
            status.generation_status === 'completed' && before.generation_status !== 'completed';
          const summaryJustFinished =
            before.summary_status === 'generating' &&
            (status.summary_status === 'completed' || status.summary_status === 'failed');

          // Pull the FULL item once, now that it's done (transcript, alignment, summary text)
          if (audioJustCompleted || summaryJustFinished) {
            setTimeout(() => refreshItem(status.id), 500);
          }

          if (audioJustCompleted) {
            setRecentlyCompleted(prev => new Map(prev).set(status.id, Date.now()));
            // Clear from recently completed after 5 seconds
            setTimeout(() => {
              setRecentlyCompleted(prev => {
                const newMap = new Map(prev);
                newMap.delete(status.id);
                return newMap;
              });
            }, 5000);
          }
        }
      } catch (error) {
        console.error('Failed to fetch item statuses:', error);
      }
    }, 2000);

    return () => clearInterval(pollInterval);
  }, [content, updateItem, refreshItem]);

  // In-progress audio items from the CURRENT filtered view (so archived items stay
  // hidden while viewing Active, etc.), most recently played first. 1%-99% window:
  // below 1% is accidental-tap noise, above 99% is effectively finished.
  const continueItems = useMemo(() => {
    return content
      .filter(item => {
        if (!item.audio_url || !item.duration || !item.last_played_at) return false;
        const frac = (item.playback_position || 0) / item.duration;
        return frac > 0.01 && frac < 0.99;
      })
      .sort((a, b) => new Date(b.last_played_at!).getTime() - new Date(a.last_played_at!).getTime())
      .slice(0, 12);
  }, [content]);

  const continueTypeIcon = (t: string) =>
    t === 'podcast_episode' ? <Podcast size={12} /> : t === 'text' ? <NotebookPen size={12} /> : <Newspaper size={12} />;

  // The progress bar carries the type identity (icon stays muted). Article and
  // text use the pill colors; podcast purple is the brighter 400-tier because
  // the pill purple reads muddy on a 3px line against the dark background.
  const TYPE_BAR_COLORS: Record<string, string> = {
    article: '#3b82f6',
    text: '#10b981',
    podcast_episode: '#c084fc',
  };

  const handlePlayContent = async (item: ContentItem, opts?: { tab?: 'summary' }) => {
    try {
      // Fetch latest content data to get current playback position
      const response = await contentAPI.getById(item.id);
      onPlayContent(response.data, opts);
    } catch (error) {
      console.error('Failed to load content details:', error);
      // Fall back to using the list item if fetch fails
      onPlayContent(item, opts);
    }
  };

  const handleToggleStarred = async (id: number) => {
    await toggleStarred(id);
  };

  const handleToggleArchive = async (id: number) => {
    // The one destructive case: archiving a NON-STARRED article/text WITH generated
    // audio wipes that audio server-side. Warn exactly there (toggleable in Settings).
    const item = content.find(c => c.id === id);
    if (
      warnArchiveAudio && item && !item.is_archived && !item.is_starred &&
      (item.type === 'article' || item.type === 'text') && item.audio_url &&
      !confirm("Archiving removes this item's generated audio (starred items keep theirs). Archive anyway?")
    ) return;
    await toggleArchived(id);
  };

  const handleDelete = async (id: number) => {
    await deleteItem(id);
  };

  const handleCancelGeneration = async (id: number) => {
    try {
      await contentAPI.cancelGeneration(id);
      // Refresh the item to show cancelled status
      await refreshItem(id);
    } catch (error) {
      console.error('Failed to cancel generation:', error);
    }
  };

  const toggleSelection = (id: number) => {
    const newSelected = new Set(selectedItems);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedItems(newSelected);
  };

  const selectAll = () => {
    setSelectedItems(new Set(content.map(item => item.id)));
  };

  const deselectAll = () => {
    setSelectedItems(new Set());
  };

  type BulkAction = 'star' | 'unstar' | 'archive' | 'unarchive' | 'delete' | 'remove_audio' | 'remove_summary';

  // Instant bulk actions: one request to POST /content/bulk, then refetch.
  // Refetching (instead of optimistic updates) keeps us in sync with server
  // side effects like archive wiping audio or delete propagating to Wallabag.
  const runInstantBulk = async (action: BulkAction, confirmMsg?: string) => {
    // Intersect with the visible list. Defensive, selection should already
    // only contain visible items
    const ids = content.filter(item => selectedItems.has(item.id)).map(item => item.id);
    if (ids.length === 0) return;
    if (confirmMsg && !confirm(confirmMsg)) return;
    setBulkMenuOpen(false);
    try {
      await contentAPI.bulkAction(action, ids);
      setSelectedItems(new Set());
      await fetchContent();
    } catch (error) {
      console.error(`Bulk ${action} failed:`, error);
      alert('Bulk action failed');
    }
  };

  // Long-running bulk actions: kick off existing per-item endpoints one by
  // one. The start endpoints return immediately; real progress comes from the
  // existing 2-second generation poll once each item's status flips.
  const runSequentialBulk = async (label: string, ids: number[], fn: (id: number) => Promise<unknown>) => {
    setBulkMenuOpen(false);
    setBulkProgress({ label, done: 0, total: ids.length });
    let failed = 0;
    for (let i = 0; i < ids.length; i++) {
      try {
        await fn(ids[i]);
        refreshItem(ids[i]);
      } catch (error) {
        failed++;
        console.error(`${label} failed for item ${ids[i]}:`, error);
      }
      setBulkProgress({ label, done: i + 1, total: ids.length });
    }
    setBulkProgress(null);
    setSelectedItems(new Set());
    if (failed > 0) alert(`${label}: ${failed} of ${ids.length} failed (see console).`);
  };

  const selectedContentItems = () => content.filter(item => selectedItems.has(item.id));

  const handleBulkGenerateAudio = async () => {
    setBulkMenuOpen(false);
    if (selectedItems.size === 0) return;
    let maxComments = 50;
    try {
      const res = await userSettingsAPI.get('max_narrated_comments');
      if (res.data.value) maxComments = parseInt(res.data.value, 10) || 50;
    } catch { /* use default */ }

    const candidates = selectedContentItems().filter(item =>
      (item.type === 'article' || item.type === 'text') &&
      !item.audio_url &&
      (!item.generation_status || ['idle', 'failed', 'completed'].includes(item.generation_status))
    );
    const notTooChatty = candidates.filter(item => !item.comment_count || item.comment_count <= maxComments);
    const skipped = candidates.length - notTooChatty.length;
    // Mirror the single-item very-long gate: bulk skips instead of asking per item.
    const eligible = notTooChatty.filter(item => !isVeryLongArticle(item));
    const skippedLong = notTooChatty.length - eligible.length;

    if (eligible.length === 0) {
      alert('No selected items are eligible (needs to be an article/text without audio).');
      return;
    }
    const skipNote =
      (skipped > 0 ? `\n\nSkipping ${skipped} item(s) with more than ${maxComments} comments. Generate those individually.` : '') +
      (skippedLong > 0 ? `\n\nSkipping ${skippedLong} very long article(s) (over 100,000 characters). Generate those individually.` : '');
    if (!confirm(`Generate audio for ${eligible.length} item(s)? This uses your TTS API credits.${skipNote}`)) return;
    await runSequentialBulk('Starting audio generation', eligible.map(i => i.id), id => contentAPI.generateAudio(id, false));
  };

  const handleBulkGenerateSummaries = async () => {
    setBulkMenuOpen(false);
    if (selectedItems.size === 0) return;
    const eligible = selectedContentItems().filter(item =>
      (item.type === 'article' || item.type === 'text' || item.type === 'podcast_episode') &&
      !item.summary_generated_at &&
      item.summary_status !== 'generating'
    );
    if (eligible.length === 0) {
      alert('No selected items are eligible (no summary yet).');
      return;
    }
    // Podcasts without a transcript need Whisper first, so ask via the modal instead
    // of silently spending transcription credits
    const podcastIds = eligible.filter(i => i.type === 'podcast_episode' && !i.transcript_words).map(i => i.id);
    const readyIds = eligible.filter(i => !(i.type === 'podcast_episode' && !i.transcript_words)).map(i => i.id);
    if (podcastIds.length > 0) {
      setTranscriptWarning({ podcastIds, readyIds });
      return;
    }
    if (!confirm(`Generate summaries for ${readyIds.length} item(s)? This uses your LLM API credits.`)) return;
    await runSummaryBatch(readyIds, []);
  };

  const handleBulkRefetch = async () => {
    setBulkMenuOpen(false);
    if (selectedItems.size === 0) return;
    const eligible = selectedContentItems().filter(item => item.type === 'article' && item.url);
    if (eligible.length === 0) {
      alert('No selected items are eligible (needs to be an article with a URL).');
      return;
    }
    if (!confirm(`Refetch ${eligible.length} article(s) from the web?`)) return;
    await runSequentialBulk('Refetching', eligible.map(i => i.id), id => contentAPI.refetch(id));
    // Refetch is fire-and-forget on the backend, so refresh after delays to pick
    // up updated data (bulk analogue of the 3s/8s per-item refreshes)
    setTimeout(() => fetchContent(), 4000);
    setTimeout(() => fetchContent(), 10000);
  };

  const doGenerateAudio = async (id: number, regenerate: boolean, excludeComments: boolean) => {
    try {
      setOpenDropdown(null);
      await contentAPI.generateAudio(id, regenerate, excludeComments);
      refreshItem(id);
    } catch (error: any) {
      console.error('Failed to generate audio:', error);
      const errorMsg = error?.response?.data?.error || 'Failed to generate audio';
      alert(errorMsg);
    }
  };

  const handleGenerateAudio = async (id: number, regenerate: boolean = false) => {
    setOpenDropdown(null);
    const item = content.find(c => c.id === id);
    if (item && isVeryLongArticle(item) && !confirm(`This article is very long (${(item.content || '').length.toLocaleString('en-US')} characters). Generate audio anyway?`)) return;
    if (item && item.comment_count && item.comment_count > 0) {
      let maxComments = 50;
      try {
        const res = await userSettingsAPI.get('max_narrated_comments');
        if (res.data.value) maxComments = parseInt(res.data.value, 10) || 50;
      } catch { /* use default */ }
      if (item.comment_count > maxComments) {
        setCommentWarning({ id, regenerate, commentCount: item.comment_count, maxComments });
        return;
      }
    }
    doGenerateAudio(id, regenerate, false);
  };

  const handleRemoveAudio = async (id: number) => {
    try {
      setOpenDropdown(null);
      await contentAPI.update(id, { audio_data: null, audio_url: null } as any);
      refreshItem(id);
    } catch (error) {
      console.error('Failed to remove audio:', error);
      alert('Failed to remove audio');
    }
  };

  const handleGenerateSummary = async (id: number, regenerate: boolean = false) => {
    setOpenDropdown(null);
    // Podcasts summarize their TRANSCRIPT (not the episode description). If there's no
    // transcript yet, ask before kicking off Whisper + summary
    const item = allItems.find(c => c.id === id);
    if (item && item.type === 'podcast_episode' && !item.transcript_words) {
      setTranscriptWarning({ podcastIds: [id], readyIds: [] });
      return;
    }
    try {
      await contentAPI.generateSummary(id, regenerate);
      // Mark as generating immediately so the badge/poll kick in without waiting for a refetch
      updateItem(id, { summary_status: 'generating' });
      refreshItem(id);
    } catch (error: any) {
      console.error('Failed to generate summary:', error);
      alert(error?.response?.data?.error || 'Failed to generate summary');
    }
  };

  // Kick off summaries for a mixed batch: readyIds summarize directly; podcastIds get
  // a transcript first (generate_transcript=true), then the summary chains server-side.
  const runSummaryBatch = async (readyIds: number[], podcastIds: number[]) => {
    const podcastSet = new Set(podcastIds);
    const ids = [...readyIds, ...podcastIds];
    if (ids.length === 0) return;
    await runSequentialBulk('Starting summaries', ids, async (id) => {
      await contentAPI.generateSummary(id, false, podcastSet.has(id));
      // Mark as generating immediately so the badge/poll kick in without waiting for a refetch
      updateItem(id, { summary_status: 'generating' });
    });
  };

  const handleRemoveSummary = async (id: number) => {
    try {
      setOpenDropdown(null);
      await contentAPI.update(id, { summary: null } as any);
      refreshItem(id);
    } catch (error) {
      console.error('Failed to remove summary:', error);
      alert('Failed to remove summary');
    }
  };

  // Dismiss a failed-generation or failed-summary error from a card (the X button).
  // Optimistically clears the status so the red box vanishes instantly, then persists it.
  const handleDismissError = async (id: number, kind: 'generation' | 'summary') => {
    try {
      if (kind === 'summary') {
        updateItem(id, { summary_status: 'idle', summary_error: undefined });
        await contentAPI.update(id, { dismiss_summary_error: true } as any);
      } else {
        updateItem(id, { generation_status: 'idle', generation_error: undefined, current_operation: undefined, generation_progress: 0 });
        await contentAPI.update(id, { dismiss_generation_error: true } as any);
      }
    } catch (error) {
      console.error('Failed to dismiss error:', error);
      refreshItem(id);
    }
  };

  const handleRefetchContent = async (id: number) => {
    try {
      setOpenDropdown(null);
      await contentAPI.refetch(id);
      // Refetch is async on the backend, so refresh after delay to pick up updated data.
      // Two refreshes: first at 3s for fast sites, second at 8s for slower ones (e.g. Substack /comments fetch)
      setTimeout(() => refreshItem(id), 3000);
      setTimeout(() => refreshItem(id), 8000);
    } catch (error) {
      console.error('Failed to refetch content:', error);
      alert('Failed to refetch content');
    }
  };

  const handleRegenerateTranscript = async (id: number) => {
    try {
      setOpenDropdown(null);
      await contentAPI.update(id, { regenerate_transcript: true } as any);
      refreshItem(id);
    } catch (error) {
      console.error('Failed to regenerate transcript:', error);
      alert('Failed to regenerate transcript');
    }
  };

  // "Copy content" from a card. The list payload lacks html_content/comments,
  // so fetch the full item first, then reuse the shared Markdown export (the
  // exact same output as the player's Copy content).
  const handleCopyContent = async (item: ContentItem) => {
    setOpenDropdown(null);
    try {
      const full = (await contentAPI.getById(item.id)).data;
      let comments: Comment[] = [];
      try {
        comments = typeof full.comments === 'string' ? JSON.parse(full.comments) : (full.comments || []);
      } catch {
        comments = [];
      }
      await navigator.clipboard.writeText(contentToMarkdown(full, comments));
    } catch (error) {
      console.error('Failed to copy content:', error);
      alert('Failed to copy to clipboard');
    }
  };

  const handleDownloadDataZip = async (item: ContentItem) => {
    setOpenDropdown(null);
    try {
      const response = await contentAPI.exportZip(item.id);
      const blob = new Blob([response.data], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(item.title || 'content').replace(/[^a-zA-Z0-9-_ ]/g, '')}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export data:', error);
      alert('Failed to download data');
    }
  };

  return (
    <div className="library-tab">
      <div className="library-header">
        {searchOpen && (
          <div className="library-search">
            <Search size={16} className="library-search-icon" />
            <input
              type="search"
              className="library-search-input"
              placeholder="Search library…"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
              enterKeyHint="search"
            />
            <button
              className="library-search-clear"
              onClick={() => { setSearchInput(''); setSearchQuery(''); setSearchOpen(false); }}
              title="Close search"
            >
              <X size={16} />
            </button>
          </div>
        )}
        <div className="header-top">
          <div className="filter-buttons">
            <button
              className={searchOpen || searchQuery.trim() ? 'active' : ''}
              onClick={() => {
                if (searchOpen) {
                  setSearchInput('');
                  setSearchQuery('');
                  setSearchOpen(false);
                } else {
                  setSearchOpen(true);
                }
              }}
              title="Search library"
            >
              <Search size={16} />
            </button>
            {/* Bulk-select mode toggle, styled like its toolbar neighbors
                (replaces the old wide standalone Select/Cancel text button) */}
            <button
              className={bulkMode ? 'active' : ''}
              onClick={() => { setBulkMode(!bulkMode); setSelectedItems(new Set()); }}
              title={bulkMode ? 'Exit selection' : 'Select items'}
            >
              {bulkMode ? <X size={16} /> : <ListChecks size={16} />}
              <span className="filter-label">{bulkMode ? 'Cancel' : 'Select'}</span>
            </button>
            {/* Sort by date added: newest first (default) or oldest first.
                Sorting lives in the store, so the queue's "Up next" follows. */}
            <button
              className={sortDir === 'asc' ? 'active' : ''}
              onClick={() => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')}
              title={sortDir === 'asc' ? 'Oldest added first, tap for newest first' : 'Newest added first, tap for oldest first'}
            >
              {sortDir === 'asc' ? <ArrowUpNarrowWide size={16} /> : <ArrowDownWideNarrow size={16} />}
              <span className="filter-label">{sortDir === 'asc' ? 'Oldest' : 'Newest'}</span>
            </button>
            <div className="dropdown-container" ref={statusMenuRef}>
              {/* Facet filter: the button shows the icon of every selected facet
                  (or a funnel when nothing is selected = show everything) */}
              <button
                className="status-funnel-btn active"
                onClick={() => setStatusMenuOpen(!statusMenuOpen)}
                title="Filter library"
              >
                {(() => {
                  const icons = FACET_ROWS.flatMap(row => {
                    const opt = row.options.find(o => o.value === facets[row.dim]);
                    return opt ? [<span key={row.dim} className="facet-btn-icon">{opt.icon}</span>] : [];
                  });
                  return icons.length > 0 ? icons : <FunnelX size={16} />;
                })()}
                <ChevronDown size={14} />
              </button>
              {statusMenuOpen && (
                <div className="dropdown-menu menu-left filter-grid">
                  {FACET_ROWS.map(row =>
                    row.options.map(opt => {
                      const isSelected = facets[row.dim] === opt.value;
                      return (
                        <button
                          key={`${row.dim}-${opt.value}`}
                          className={isSelected ? 'selected' : undefined}
                          onClick={() => toggleFacet(row.dim, opt.value)}
                          onDoubleClick={() => soloFacet(row.dim, opt.value)}
                          style={isSelected ? { color: '#60a5fa' } : undefined}
                        >
                          {opt.icon}
                          <span className="facet-label">{opt.label}</span>
                          {isSelected && <Check size={14} className="facet-check" />}
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
            <div className="filter-chips-scroll">
              <button
                className={typeFilter === 'all' ? 'active' : ''}
                onClick={() => changeTypeFilter('all')}
              >
                All{typeFilter === 'all' && <span> ({typeCounts.all})</span>}
              </button>
              <button
                className={typeFilter === 'articles' ? 'active' : ''}
                onClick={() => changeTypeFilter('articles')}
              >
                <Newspaper size={16} />
                <span className="filter-label">Articles</span>
                {typeFilter === 'articles' && <span>({typeCounts.articles})</span>}
              </button>
              <button
                className={typeFilter === 'texts' ? 'active' : ''}
                onClick={() => changeTypeFilter('texts')}
              >
                <NotebookPen size={16} />
                <span className="filter-label">Texts</span>
                {typeFilter === 'texts' && <span>({typeCounts.texts})</span>}
              </button>
              <button
                className={typeFilter === 'podcasts' ? 'active' : ''}
                onClick={() => changeTypeFilter('podcasts')}
              >
                <Podcast size={16} />
                <span className="filter-label">Podcasts</span>
                {typeFilter === 'podcasts' && <span>({typeCounts.podcasts})</span>}
              </button>
            </div>
          </div>
        </div>
        {bulkMode && (
          <div className="bulk-actions">
            <span className="bulk-count">{selectedItems.size} selected</span>
            <button onClick={selectAll}>All</button>
            <button onClick={deselectAll}>None</button>
            {/* Smart toggles (Gmail-style): star/archive act on the whole selection.
                Mixed selections get starred/archived, and uniform ones get the inverse. */}
            <button
              onClick={() => runInstantBulk(allSelectedStarred ? 'unstar' : 'star')}
              title={allSelectedStarred ? 'Unstar selected' : 'Star selected'}
            >
              <Star size={16} fill={allSelectedStarred ? 'currentColor' : 'none'} style={allSelectedStarred ? { color: '#fbbf24' } : undefined} />
            </button>
            {allSelectedArchived ? (
              <button onClick={() => runInstantBulk('unarchive')} title="Unarchive selected">
                <ArchiveRestore size={16} style={{ color: '#60a5fa' }} />
              </button>
            ) : (
              <button
                onClick={() => {
                  const risky = selectedContentItems().filter(i =>
                    !i.is_archived && !i.is_starred && (i.type === 'article' || i.type === 'text') && i.audio_url
                  ).length;
                  runInstantBulk(
                    'archive',
                    warnArchiveAudio && risky > 0
                      ? `Archive ${selectedItems.size} item(s)? ${risky} of these have generated audio, which archiving removes (starred items keep theirs).`
                      : undefined
                  );
                }}
                title="Archive selected"
              >
                <Archive size={16} />
              </button>
            )}
            <button
              onClick={() => runInstantBulk('delete', `Delete ${selectedItems.size} item(s)? Wallabag-synced items will be deleted there too. This cannot be undone.`)}
              title="Delete selected"
            >
              <Trash2 size={16} style={{ color: '#ef4444' }} />
            </button>
            <div className="dropdown-container" ref={bulkMenuRef}>
              <button onClick={() => setBulkMenuOpen(!bulkMenuOpen)} title="More bulk actions">
                <MoreVertical size={16} />
              </button>
              {bulkMenuOpen && (
                <div className="dropdown-menu">
                  <button onClick={() => runInstantBulk('remove_audio', `Remove generated audio from ${selectedItems.size} item(s)? (Podcast episodes are never affected.)`)}>
                    Remove audio
                  </button>
                  <button onClick={() => runInstantBulk('remove_summary', `Remove summaries from ${selectedItems.size} item(s)?`)}>
                    Remove summaries
                  </button>
                  <button onClick={handleBulkGenerateAudio}>Generate audio</button>
                  <button onClick={handleBulkGenerateSummaries}>Generate summaries</button>
                  <button onClick={handleBulkRefetch}>Refetch from web</button>
                </div>
              )}
            </div>
          </div>
        )}
        {bulkProgress && (
          <div className="bulk-progress">{bulkProgress.label} {bulkProgress.done}/{bulkProgress.total}…</div>
        )}
      </div>

      {showContinueStrip && !bulkMode && continueItems.length > 0 && (
        <div className="continue-strip">
          <div className="continue-strip-label">Continue listening</div>
          <div className="continue-strip-row">
            {continueItems.map(item => (
              <button
                key={item.id}
                className="continue-card"
                onClick={() => handlePlayContent(item)}
                title={item.title}
              >
                {/* No image = no placeholder: the type icon already sits right of
                    the title, so the title just gets the extra width instead */}
                {item.preview_picture && (
                  <img src={item.preview_picture} alt="" loading="lazy" />
                )}
                <span className="continue-card-title">{item.title}</span>
                <span className="continue-card-type">{continueTypeIcon(item.type)}</span>
                <span
                  className="continue-card-progress"
                  style={{
                    width: `${Math.round(((item.playback_position || 0) / (item.duration || 1)) * 100)}%`,
                    background: TYPE_BAR_COLORS[item.type] || '#3b82f6',
                  }}
                />
              </button>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="loading">Loading...</div>
      ) : content.length === 0 ? (
        <div className="empty-state">
          {searchQuery.trim() ? (
            <p>No results for “{searchQuery.trim()}”.</p>
          ) : (
            <p>No content found. Start by adding some articles or subscribing to podcasts!</p>
          )}
        </div>
      ) : (
        <div className={`content-list${showSummaryInLibrary ? ' tweet-mode' : ''}`}>
          {content.map((item) => (
            <ContentCard
              key={item.id}
              item={item}
              bulkMode={bulkMode}
              selected={selectedItems.has(item.id)}
              onToggleSelect={toggleSelection}
              onPlay={handlePlayContent}
              searchQuery={searchQuery}
              showSummary={showSummaryInLibrary}
              justCompleted={recentlyCompleted.has(item.id)}
              dropdownOpen={openDropdown === item.id}
              dropdownRef={openDropdown === item.id ? dropdownRef : null}
              onToggleDropdown={() => setOpenDropdown(openDropdown === item.id ? null : item.id)}
              onCancelGeneration={handleCancelGeneration}
              onToggleStarred={handleToggleStarred}
              onToggleArchive={handleToggleArchive}
              onDelete={handleDelete}
              onGenerateAudio={handleGenerateAudio}
              onRemoveAudio={handleRemoveAudio}
              onGenerateSummary={handleGenerateSummary}
              onRemoveSummary={handleRemoveSummary}
              onDismissError={handleDismissError}
              onRegenerateTranscript={handleRegenerateTranscript}
              onRefetch={handleRefetchContent}
              onAddToQueue={(it) => { setOpenDropdown(null); useQueueStore.getState().addToQueue(it); }}
              onCopyContent={handleCopyContent}
              onDownloadZip={handleDownloadDataZip}
            />
          ))}
        </div>
      )}

      {transcriptWarning && (
        <div className="comment-warning-overlay" onClick={() => setTranscriptWarning(null)}>
          <div className="comment-warning-modal" onClick={e => e.stopPropagation()}>
            <p>
              {transcriptWarning.podcastIds.length === 1 && transcriptWarning.readyIds.length === 0 ? (
                <>This episode has <strong>no transcript</strong> yet. Podcast summaries are made from the transcript, so one needs to be generated first (this uses your transcription API credits). The summary follows automatically.</>
              ) : (
                <><strong>{transcriptWarning.podcastIds.length} podcast episode{transcriptWarning.podcastIds.length > 1 ? 's' : ''}</strong> in your selection {transcriptWarning.podcastIds.length > 1 ? 'have' : 'has'} no transcript yet. Podcast summaries are made from the transcript, so those need to be generated first (this uses your transcription API credits). Summaries follow automatically.</>
              )}
            </p>
            <div className="comment-warning-buttons">
              <button
                className="comment-warning-btn include"
                onClick={() => {
                  const w = transcriptWarning;
                  setTranscriptWarning(null);
                  runSummaryBatch(w.readyIds, w.podcastIds);
                }}
              >
                Generate transcript{transcriptWarning.podcastIds.length > 1 ? 's' : ''} + summar{transcriptWarning.podcastIds.length + transcriptWarning.readyIds.length > 1 ? 'ies' : 'y'}
              </button>
              {transcriptWarning.readyIds.length > 0 && (
                <button
                  className="comment-warning-btn exclude"
                  onClick={() => {
                    const w = transcriptWarning;
                    setTranscriptWarning(null);
                    runSummaryBatch(w.readyIds, []);
                  }}
                >
                  Skip episodes without transcript
                </button>
              )}
              <button
                className="comment-warning-btn cancel"
                onClick={() => setTranscriptWarning(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {commentWarning && (
        <div className="comment-warning-overlay" onClick={() => setCommentWarning(null)}>
          <div className="comment-warning-modal" onClick={e => e.stopPropagation()}>
            <p>This article has <strong>{commentWarning.commentCount} comments</strong> (your auto-generate limit is {commentWarning.maxComments}). Generating audio with this many comments may take a long time.</p>
            <div className="comment-warning-buttons">
              <button
                className="comment-warning-btn exclude"
                onClick={() => {
                  const { id, regenerate } = commentWarning;
                  setCommentWarning(null);
                  doGenerateAudio(id, regenerate, true);
                }}
              >
                Exclude comments
              </button>
              <button
                className="comment-warning-btn include"
                onClick={() => {
                  const { id, regenerate } = commentWarning;
                  setCommentWarning(null);
                  doGenerateAudio(id, regenerate, false);
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
    </div>
  );
}
